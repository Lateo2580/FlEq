import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ClockReading, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAbortRequest, NotificationAttempt, NotificationChannel, NotificationChannelState } from "../../contracts/p2-notification-delivery.types";

type StopObservation = Readonly<{ attemptId: string; stopped: boolean; completedAt: ClockReading }>;
type Active = {
  attempt: NotificationAttempt;
  child: childProcess.ChildProcess | null;
  cause: NotificationAbortRequest["cause"] | null;
  closed: boolean;
  noChild: boolean;
  stopObservation: StopObservation | null;
  waiters: ((observation: StopObservation) => void)[];
  stop: (stopped: boolean, completedAt: ClockReading) => void;
};
const active: Record<NotificationChannel, Active | null> = { desktop: null, sound: null };

function commands(attempt: NotificationAttempt, probeWav?: string): readonly (readonly [string, readonly string[]])[] {
  if (attempt.channel === "desktop") {
    const { title, body } = attempt.payload;
    if (typeof title !== "string" || typeof body !== "string" || title.length === 0 || body.length === 0)
      throw new RangeError("invalid desktop payload");
    if (process.platform === "darwin") return [["/usr/bin/osascript", ["-e", "on run argv", "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body]]];
    if (process.platform === "linux") return [["/usr/bin/notify-send", ["--expire-time=10000", "--", title, body]]];
  } else {
    if (attempt.soundAsset == null) throw new RangeError("missing sound asset");
    const wav = resolve(probeWav ?? attempt.soundAsset);
    if (process.platform === "darwin") return [["/usr/bin/afplay", [wav]]];
    if (process.platform === "linux") return [
      ["/usr/bin/ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", wav]],
      ["/usr/bin/paplay", [wav]], ["/usr/bin/aplay", ["-q", wav]],
    ];
  }
  throw new RangeError("unsupported notification backend");
}

function runAttempt(attempt: NotificationAttempt, clock: () => ClockReading, probeWav?: string): Promise<NotificationResult> {
  if (active[attempt.channel] != null) throw new Error("notification channel occupied");
  let resolveResult!: (result: NotificationResult) => void;
  const terminal = new Promise<NotificationResult>((resolvePromise) => { resolveResult = resolvePromise; });
  let settled = false;
  const base = (completedAt: ClockReading) => ({ attemptId: attempt.attemptId, intentId: attempt.intentId,
    channel: attempt.channel, completedAt });
  const finish = (result: NotificationResult) => {
    if (settled) return;
    settled = true;
    if (result.kind !== "timeout" && result.kind !== "aborted" || result.stopped) active[attempt.channel] = null;
    resolveResult(result);
  };
  const context: Active = { attempt, child: null, cause: null, closed: false, noChild: true,
    stopObservation: null, waiters: [], stop: (stopped, completedAt) => {
      if (context.stopObservation != null || context.cause == null) return;
      context.stopObservation = { attemptId: attempt.attemptId, stopped, completedAt };
      finish(context.cause === "timeout" ? { ...base(completedAt), kind: "timeout", stopped }
        : { ...base(completedAt), kind: "aborted", reason: context.cause, stopped });
      for (const waiter of context.waiters.splice(0)) waiter(context.stopObservation);
    } };
  active[attempt.channel] = context;
  let backends: ReturnType<typeof commands>;
  try { backends = commands(attempt, probeWav); }
  catch { finish({ ...base(clock()), kind: "failed", reason: "adapterError" }); return terminal; }

  const launch = (index: number) => {
    if (settled || context.cause != null) return;
    // A1 owns semantic stop causes. With no process running, report the reached attempt deadline;
    // result adoption applies TTL first, including monotonic TTL that only A1's map knows.
    const adapterCalledAt = clock();
    if (adapterCalledAt.wallTimeMs >= attempt.expiresAt || adapterCalledAt.monotonicMs >= attempt.timeoutAtMonotonicMs) {
      finish({ ...base(adapterCalledAt), kind: "timeout", stopped: true });
      return;
    }
    const [executable, argv] = backends[index];
    context.child = null;
    context.closed = false;
    context.noChild = true;
    let child: childProcess.ChildProcess;
    try { child = childProcess.spawn(executable, [...argv], { shell: false, stdio: "ignore" }); }
    catch {
      // Synchronous spawn failure proves there is no child; no close event can follow.
      if (index + 1 < backends.length) launch(index + 1);
      else finish({ ...base(clock()), kind: "failed", reason: "adapterError" });
      return;
    }
    context.child = child;
    context.noChild = false;
    let errored = false;
    child.once("error", () => {
      errored = true;
      context.noChild = child.pid == null;
      // This proves stop only. A fallback must still wait for this handle's real close.
      if (context.noChild && context.cause != null) context.stop(true, clock());
    });
    child.once("close", (code: number | null) => {
      const completedAt = clock();
      context.closed = true;
      if (settled) return;
      if (context.cause != null) { context.stop(true, completedAt); return; }
      if (!errored && code === 0) { finish({ ...base(completedAt), kind: "delivered" }); return; }
      if (index + 1 < backends.length) launch(index + 1);
      else finish({ ...base(completedAt), kind: "failed", reason: errored ? "adapterError" : "adapterRejected" });
    });
  };
  launch(0);
  // A1 deadline inputs produce the reason and absolute stop deadline; run never invents an abort request.
  return terminal;
}

function runNotificationAttempt(attempt: NotificationAttempt, clock: () => ClockReading): Promise<NotificationResult> {
  return runAttempt(attempt, clock);
}

function abortNotificationAttempt(request: NotificationAbortRequest, stopByMonotonicMs: number,
  clock: () => ClockReading): Promise<StopObservation> {
  const { attemptId } = request;
  const context = active.desktop?.attempt.attemptId === attemptId ? active.desktop
    : active.sound?.attempt.attemptId === attemptId ? active.sound : null;
  if (context == null) return Promise.resolve({ attemptId, stopped: true, completedAt: clock() });
  if (context.stopObservation != null) return Promise.resolve(context.stopObservation);
  const firstRequest = context.cause == null;
  context.cause ??= request.cause;
  const stopped = new Promise<StopObservation>((resolveStop) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    context.waiters.push((observation) => { clearTimeout(timer); resolveStop(observation); });
    const waitUntilDeadline = () => {
      const now = clock();
      const remaining = stopByMonotonicMs - now.monotonicMs;
      if (context.closed || context.noChild) context.stop(true, now);
      else if (remaining <= 0) context.stop(false, now);
      else timer = setTimeout(waitUntilDeadline, remaining);
    };
    if (firstRequest) {
      try { context.child?.kill("SIGTERM"); } catch { /* A failed kill is not stop evidence. */ }
    }
    if (context.stopObservation == null) waitUntilDeadline();
  });
  return stopped;
}

// R34: startup calls once; missing desktop must not become a per-intent spawn/retry loop.
function probeDesktopBackend(): Extract<NotificationChannelState, { kind: "idle" | "unavailable" }> {
  const executable = process.platform === "darwin" ? "/usr/bin/osascript"
    : process.platform === "linux" ? "/usr/bin/notify-send" : null;
  return executable != null && existsSync(executable) ? { kind: "idle" }
    : { kind: "unavailable", reason: "backendMissing" };
}

// AC06: the caller owns a silent WAV in os.tmpdir(); probe shares delivery's finite player/close path.
async function probeSoundBackend(silentWavPath: string, clock: () => ClockReading): Promise<NotificationResult> {
  const start = clock();
  const attempt: NotificationAttempt = { attemptId: "sound-probe", intentId: "sound-probe", unit: "U-W",
    subject: "sound-probe", operation: "normal", channel: "sound", priorityGroup: "other",
    payload: { domain: "weather", level: "info" }, soundAsset: "reconstruction/assets/sounds/weather-info.wav",
    selectedAtMonotonicMs: start.monotonicMs, timeoutAtMonotonicMs: start.monotonicMs + 5_000,
    expiresAt: start.wallTimeMs + 5_000 };
  const run = runAttempt(attempt, clock, silentWavPath);
  // Probe has no business owner; its own deadline must also end a hung player.
  const timer = setTimeout(() => {
    const now = clock();
    void abortNotificationAttempt({ attemptId: attempt.attemptId, cause: "timeout" }, now.monotonicMs + 1_000, clock);
  }, Math.max(0, attempt.timeoutAtMonotonicMs - clock().monotonicMs));
  try { return await run; } finally { clearTimeout(timer); }
}

export { runNotificationAttempt, abortNotificationAttempt, probeDesktopBackend, probeSoundBackend };
