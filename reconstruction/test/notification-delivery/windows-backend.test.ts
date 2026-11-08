import type { SpawnOptions } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClockReading, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, resolveRepoPath, runNotificationAttempt } from "../../src/notification-delivery/adapter";

type Spawned = { executable: string; code: number | null; stderr: string; ms: number };
const spawned = vi.hoisted(() => { const list: Spawned[] = []; return list; });
// P3-NW-T03: 製品の stdin は ignore のまま stdout と stderr だけ pipe にして、exit code・標準エラー・spawn から close までの ms を log へ出す。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn((executable: string, argv: readonly string[], options: SpawnOptions) => {
    const startedAt = performance.now();
    const child = actual.spawn(executable, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("close", (code) => {
      const entry = { executable, code, stderr, ms: Math.round(performance.now() - startedAt) };
      spawned.push(entry);
      console.log(`P3-NW-T03 ${JSON.stringify(entry)}`);
    });
    return child;
  }) };
});

const REPO = join(__dirname, "../../..");
const clock = (): ClockReading => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
function attemptOf(attemptId: string, channel: NotificationAttempt["channel"], payload: NotificationAttempt["payload"],
  soundAsset: NotificationAttempt["soundAsset"], limitMs: number): NotificationAttempt {
  const now = clock();
  return { attemptId, intentId: attemptId, unit: "U-W", subject: attemptId, operation: "normal", channel, priorityGroup: "other", payload,
    soundAsset, selectedAtMonotonicMs: now.monotonicMs, timeoutAtMonotonicMs: now.monotonicMs + limitMs, expiresAt: now.wallTimeMs + limitMs };
}
// 製品の A1 の代わりに試行の期限で止める。止めないと Show や PlaySync が戻らないとき子が試験の後まで残る。
async function attempt(value: NotificationAttempt): Promise<{ result: NotificationResult; runs: Spawned[] }> {
  const before = spawned.length;
  const run = runNotificationAttempt(value, clock);
  const timer = setTimeout(() => void abortNotificationAttempt({ attemptId: value.attemptId, cause: "timeout" }, clock().monotonicMs + 1_000, clock),
    value.timeoutAtMonotonicMs - clock().monotonicMs);
  try { return { result: await run, runs: spawned.slice(before) }; } finally { clearTimeout(timer); }
}
// kind は合否にしない（runner に音声デバイスと対話のデスクトップが無い）。script の構文の誤りだけを落とす。
const parsed = (runs: Spawned[]) => { expect(runs).toHaveLength(1); expect(runs[0].stderr).not.toMatch(/ParserError/); };

// P3-NW-T03 受入条件（AC01〜AC05）。本物の powershell.exe を起こすので win32 でだけ走る。
describe.skipIf(process.platform !== "win32")("P3-NW-T03 acceptance: the real Windows PowerShell backends", () => {
  // 一時 dir は hook で作る（skip した suite は hook を走らせないので、他の OS で作って残さない）。
  let work = "";
  beforeAll(() => { work = mkdtempSync(join(tmpdir(), "fleq-nw-t03-")); });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("(a)(b) the desktop probe is idle and the silent sound probe runs the script without a parse error", async () => {
    expect(probeDesktopBackend()).toEqual({ kind: "idle" });
    const silent = Buffer.from(readFileSync(resolveRepoPath("reconstruction/assets/sounds/weather-info.wav")));
    silent.fill(0, 44);
    const path = join(work, "silent.wav");
    writeFileSync(path, silent);
    const before = spawned.length;
    console.log(`P3-NW-T03 probe ${JSON.stringify(await probeSoundBackend(path, clock))}`);
    parsed(spawned.slice(before));
  });

  it("(c) an asset WAV runs the sound script without a parse error", async () => {
    const { result, runs } = await attempt(attemptOf("t03-sound", "sound", { domain: "earthquake-eew", level: "warning" },
      "reconstruction/assets/sounds/earthquake-eew-warning.wav", 10_000));
    console.log(`P3-NW-T03 sound ${JSON.stringify(result)}`);
    parsed(runs);
  });

  it("(d) a title written as PowerShell code stays text", async () => {
    const marker = join(work, "injected");
    const { result, runs } = await attempt(attemptOf("t03-desktop", "desktop", { title: `'; New-Item ${marker} #`, body: "本文" }, null, 5_000));
    console.log(`P3-NW-T03 desktop ${JSON.stringify(result)}`);
    parsed(runs);
    expect(existsSync(marker)).toBe(false);
  });

  it("(e) fleq replay stays silent and leaves both channels available", () => {
    const out = join(work, "replay");
    const replayed = spawnSync(process.execPath, [join(REPO, "reconstruction/cli/fleq.mjs"), "replay", "--out", out, "test__fixtures__37_01_01_240613_VXSE43"],
      { cwd: REPO, encoding: "utf8", timeout: 60_000 });
    expect(replayed.status, replayed.stderr).toBe(0);
    const diag = join(out, "diag");
    const failed = (existsSync(diag) ? readdirSync(diag) : []).filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(diag, name), "utf8").split("\n")).filter((line) => line.includes("\"notificationAttemptFailed\""));
    expect(failed).toEqual([]);
    expect(JSON.parse(replayed.stdout).snapshot.channels).toEqual({ desktop: "available", sound: "available" });
  }, 70_000);
});
