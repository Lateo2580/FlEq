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

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
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

// P3-NW-AC01 (2)・AC02 (2) の文字列を契約から写した期待（adapter の定数を import しない）。
const toastScript = "$ErrorActionPreference='Stop';$m=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];"
  + "[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime];$x=$m::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
  + "$t=$x.GetElementsByTagName('text');[void]$t.Item(0).AppendChild($x.CreateTextNode($env:FLEQ_NOTIFY_TITLE));[void]$t.Item(1).AppendChild($x.CreateTextNode($env:FLEQ_NOTIFY_BODY));"
  + "$a=$x.CreateElement('audio');$a.SetAttribute('silent','true');[void]$x.DocumentElement.AppendChild($a);"
  + "$m::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
const soundScript = "$ErrorActionPreference='Stop';(New-Object System.Media.SoundPlayer $env:FLEQ_NOTIFY_WAV).PlaySync()";
const powerShellArgv = (script: string) => ["-NoProfile", "-NonInteractive", "-Command", script];
const powerShellPath = (root: string) => `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
// adapter は SystemRoot を呼ぶたびに読む（P3-NW-AC01 (1)）。元が無ければ消し、有れば戻す（順序を変えても他の試験へ漏らさない）。
async function withSystemRoot(value: string, body: () => Promise<void>): Promise<void> {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = value;
  try { await body(); } finally { if (saved == null) delete process.env.SystemRoot; else process.env.SystemRoot = saved; }
}

// P3-NW-T01 受入条件（AC01・AC02・AC03 (2)・AC06 (1) は darwin と linux の既存の期待がそのまま通ること）
it("P3-NW-T01 acceptance: win32 spawns powershell.exe with the fixed scripts, values only in env, windowsHide, and the same result mapping", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await withSystemRoot("C:\\Windows", async () => {
    const { resolveRepoPath, runNotificationAttempt } = await import("../../src/notification-delivery/adapter");
    const now = { wallTimeMs: 0, monotonicMs: 0 };
    const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const title = "\"引用\" <山括弧> 'single'", body = "本文\n$(unchanged)";
    const delivered = child(), rejected = child(), missing = child();
    Object.defineProperty(missing, "pid", { value: undefined });
    const spawn = vi.mocked(childProcess.spawn).mockReset().mockReturnValueOnce(delivered).mockReturnValueOnce(rejected).mockReturnValueOnce(missing);
    const desktop = runNotificationAttempt({ ...attempt, payload: { title, body } }, () => now);
    delivered.emit("close", 0);
    expect(await desktop).toMatchObject({ kind: "delivered" });
    const sound: NotificationAttempt = { ...attempt, attemptId: "sound", channel: "sound", soundAsset: "reconstruction/assets/sounds/weather-info.wav" };
    const played = runNotificationAttempt(sound, () => now);
    rejected.emit("close", 1);
    expect(await played).toMatchObject({ kind: "failed", reason: "adapterRejected" });
    const notStarted = runNotificationAttempt({ ...attempt, attemptId: "missing" }, () => now);
    missing.emit("error", new Error("ENOENT"));
    missing.emit("close", null);
    expect(await notStarted).toMatchObject({ kind: "failed", reason: "notStarted" });
    const options = (env: Record<string, string>) => ({ shell: false, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
    expect(spawn.mock.calls.slice(0, 2)).toEqual([
      [exe, powerShellArgv(toastScript), options({ FLEQ_NOTIFY_TITLE: title, FLEQ_NOTIFY_BODY: body })],
      [exe, powerShellArgv(soundScript), options({ FLEQ_NOTIFY_WAV: resolveRepoPath("reconstruction/assets/sounds/weather-info.wav") })],
    ]);
  });
});

// P3-NW-T02 契約境界（AC04 (1)(3)）: 実在しない SystemRoot で powershell.exe の無い状態を OS に頼らずに作る。
it("P3-NW-T02 contractBoundary: without powershell.exe the desktop probe is unavailable and desktopNotice starts nothing", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const directory = mkdtempSync(join(tmpdir(), "fleq-nw-t02-"));
  try {
    await withSystemRoot(join(directory, "root"), async () => {
      const { desktopNotice, probeDesktopBackend } = await import("../../src/notification-delivery/adapter");
      const execFile = vi.mocked(childProcess.execFile).mockReset();
      expect(probeDesktopBackend()).toEqual({ kind: "unavailable", reason: "backendMissing" });
      await desktopNotice("回線が切れました", "再接続を待っています");
      expect(execFile).not.toHaveBeenCalled();
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// P3-NW-T04 受入条件（AC04 (3)）
it("P3-NW-T04 acceptance: desktopNotice on win32 runs the toast script through execFile with env, windowsHide and the 10 s timeout", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "fleq-nw-t04-"));
  const root = join(directory, "root");
  try {
    await withSystemRoot(root, async () => {
      // macOS では \ を含む 1 つの file 名になり、一時 dir の中に収まる。
      mkdirSync(dirname(powerShellPath(root)), { recursive: true });
      writeFileSync(powerShellPath(root), "");
      const { desktopNotice, probeDesktopBackend } = await import("../../src/notification-delivery/adapter");
      expect(probeDesktopBackend()).toEqual({ kind: "idle" }); // AC04 (1) の有る側（無い側は T02）
      const execFile = vi.mocked(childProcess.execFile).mockReset().mockReturnValue(Object.assign(child(), { unref: vi.fn() }));
      const sent = desktopNotice("回線が切れました", "再接続を待っています");
      expect(execFile).toHaveBeenCalledTimes(1);
      const [file, argv, options, callback] = execFile.mock.calls[0];
      expect([file, argv, options]).toEqual([powerShellPath(root), powerShellArgv(toastScript), { windowsHide: true, timeout: 10_000,
        env: { ...process.env, FLEQ_NOTIFY_TITLE: "回線が切れました", FLEQ_NOTIFY_BODY: "再接続を待っています" } }]);
      callback?.(null, "", "");
      await sent;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
