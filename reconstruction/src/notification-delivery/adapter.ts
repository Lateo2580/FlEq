import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ClockReading, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAbortRequest, NotificationAttempt, NotificationChannel, NotificationChannelState } from "../../contracts/p2-notification-delivery.types";

// P2-A10-AC12: without a base resolved once, a start outside the repo root loses the WAV and the probe reports sound unavailable.
// The nearest ancestor of this module holding reconstruction/assets works from both src/ and the compiled dist/ layout.
const repoRoot = (() => {
  for (let directory = __dirname; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "reconstruction", "assets", "sounds"))) return directory;
    if (dirname(directory) === directory) return process.cwd();
  }
})();
function resolveRepoPath(path: string): string { return resolve(repoRoot, path); }

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
    const wav = resolveRepoPath(probeWav ?? attempt.soundAsset);
    if (process.platform === "darwin") return [["/usr/bin/afplay", [wav]]];
    if (process.platform === "linux") return [
      ["/usr/bin/ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", wav]],
      ["/usr/bin/paplay", [wav]], ["/usr/bin/aplay", ["-q", wav]],
    ];
  }
  throw new RangeError("unsupported notification backend");
}

// P3-NL-D-SOUND-BACKEND=B: 音の backend の列の位置。composition root が run の中だけで 1 つ持ち、probe と各試行に渡す。試行は index から
// 始め、起動した backend を書き、起動した後に失敗したか時間内に終わらなかったら次へ進める（列の最後の次は先頭）。desktop は使わない。
type SoundBackend = { index: number };

function runAttempt(attempt: NotificationAttempt, clock: () => ClockReading, probeWav?: string, soundBackend?: SoundBackend): Promise<NotificationResult> {
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
  // P3-NL-AC06 (2): 列を組めなかった試行は外へ何も出していない。
  try { backends = commands(attempt, probeWav); }
  catch { finish({ ...base(clock()), kind: "failed", reason: "notStarted" }); return terminal; }
  const sound = attempt.channel === "sound" ? soundBackend : undefined;
  const first = sound == null ? 0 : sound.index % backends.length;
  // 起動した後の失敗と timeout は、その backend の次から始めさせる（上位群・期限・置換・停止の中断では backend は悪くないので進めない）。
  const advance = (index: number) => { if (sound != null) sound.index = (index + 1) % backends.length; };
  const stop = context.stop;
  let launched: number | null = null;
  context.stop = (stopped, completedAt) => {
    if (context.stopObservation == null && context.cause === "timeout" && launched != null) advance(launched);
    stop(stopped, completedAt);
  };

  // offset は列の先頭（first）から数えた位置。列を 1 周したら終える。
  const launch = (offset: number) => {
    if (settled || context.cause != null) return;
    const index = (first + offset) % backends.length;
    const next = () => offset + 1 < backends.length;
    // 止める理由は A1 が持つ。プロセスを起動していなければ試行は始まっていない（P3-NL-AC06 (2)）。結果の採用は TTL（A1 の表だけが知る
    // monotonic の TTL を含む）を先に当てる。
    const adapterCalledAt = clock();
    if (adapterCalledAt.wallTimeMs >= attempt.expiresAt || adapterCalledAt.monotonicMs >= attempt.timeoutAtMonotonicMs) {
      finish({ ...base(adapterCalledAt), kind: "failed", reason: "notStarted" });
      return;
    }
    const [executable, argv] = backends[index];
    context.child = null;
    context.closed = false;
    context.noChild = true;
    let child: childProcess.ChildProcess;
    try { child = childProcess.spawn(executable, [...argv], { shell: false, stdio: "ignore" }); }
    catch {
      // spawn の同期の失敗は子が無いことの証拠で、close は来ない。
      if (next()) launch(offset + 1);
      else finish({ ...base(clock()), kind: "failed", reason: "notStarted" });
      return;
    }
    context.child = child;
    context.noChild = false;
    launched = index;
    if (sound != null) sound.index = index;
    let errored = false;
    child.once("error", () => {
      errored = true;
      context.noChild = child.pid == null;
      // これは停止の証拠だけ。次の backend へ進むのは、この handle の本当の close を待ってから。
      if (context.noChild && context.cause != null) context.stop(true, clock());
    });
    child.once("close", (code: number | null) => {
      const completedAt = clock();
      context.closed = true;
      if (settled) return;
      if (context.cause != null) { context.stop(true, completedAt); return; }
      if (!errored && code === 0) { finish({ ...base(completedAt), kind: "delivered" }); return; }
      // P3-NL-AC06 (3): 次の backend へ進むのは、プロセスを生成できなかった（pid の無い error）ときだけ。起動した後の失敗は
      // 結果の分からない終わりで返す。probe は無音なので、前の close を確かめた後なら起動した後の失敗でも次を試す。
      const started = !(errored && child.pid == null);
      if (next() && (!started || probeWav != null)) { launch(offset + 1); return; }
      if (started) advance(index);
      finish({ ...base(completedAt), kind: "failed", reason: !started ? "notStarted" : errored ? "adapterError" : "adapterRejected" });
    });
  };
  launch(0);
  // 止める理由と絶対の停止の期限は A1 の期限の入力が作る。run は中断の要求を自分では作らない。
  return terminal;
}

function runNotificationAttempt(attempt: NotificationAttempt, clock: () => ClockReading, soundBackend?: SoundBackend): Promise<NotificationResult> {
  return runAttempt(attempt, clock, undefined, soundBackend);
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

// AC06: 無音の WAV は呼ぶ側が os.tmpdir() に持つ。probe は配送と同じ有限の player と close の経路を使う。
// P3-NL-D-SOUND-BACKEND=B: soundBackend には鳴った backend の位置が残る（delivery はそこから始める）。
async function probeSoundBackend(silentWavPath: string, clock: () => ClockReading, soundBackend?: SoundBackend): Promise<NotificationResult> {
  const start = clock();
  const attempt: NotificationAttempt = { attemptId: "sound-probe", intentId: "sound-probe", unit: "U-W",
    subject: "sound-probe", operation: "normal", channel: "sound", priorityGroup: "other",
    payload: { domain: "weather", level: "info" }, soundAsset: "reconstruction/assets/sounds/weather-info.wav",
    selectedAtMonotonicMs: start.monotonicMs, timeoutAtMonotonicMs: start.monotonicMs + 5_000,
    expiresAt: start.wallTimeMs + 5_000 };
  const run = runAttempt(attempt, clock, silentWavPath, soundBackend);
  // probe には業務の owner が無いので、自分の期限で止まった player も終わらせる。
  const timer = setTimeout(() => {
    const now = clock();
    void abortNotificationAttempt({ attemptId: attempt.attemptId, cause: "timeout" }, now.monotonicMs + 1_000, clock);
  }, Math.max(0, attempt.timeoutAtMonotonicMs - clock().monotonicMs));
  try { return await run; } finally { clearTimeout(timer); }
}

export { runNotificationAttempt, abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, resolveRepoPath };
export type { SoundBackend };
