import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocketServer } from "ws";

import { readSelfHashed } from "../../src/measurement/eew-e01/frozen";
import { buildA10Result, deadlineTriggerOverlap, distRebuildProblem, hashRaw, machineProblems, parseArgs, resumeProblems, signalStopper, trialConditionDeviation, trialWatchAtEnd } from "./run.mjs";
import type { WindowRecord } from "./run.mjs";
import { H } from "./fixtures";
import { FLAGS, openPage } from "./chrome.mjs";

const record = (id: string, attempt: number, status: WindowRecord["status"], extra: Partial<WindowRecord> = {}): WindowRecord => ({
  id, attempt, status, manifestId: "m", manifestSha256: H, rawDir: `/runs/m/${id}`, command: "node run.mjs --manifest m.json",
  commands: ["node run.mjs --manifest m.json", "caffeinate -dims -w 1"], startedAt: "2026-10-01T00:00:00.000Z",
  preflight: { gitHead: "a".repeat(40) }, resultFiles: [], ...extra,
});

describe("P2-A10-T01 runner side: a10-result aggregate (AC10)", () => {
  it("窓の status は記録のまま写し（Blocked を Pass・Fail に変えない）、封印した bytes が自己 hash 検証を通る", () => {
    const windows = [
      record("e01-fixedBacklog-run2", 1, "Blocked", { reason: "host launcher exited mid-run", childExit: { code: 1, signal: null }, lastProgress: { trialsStarted: 400 } }),
      record("e01-fixedBacklog-run1", 2, "Pass"),
      record("e01-fixedBacklog-run1", 1, "Blocked", { reason: "window deadline exceeded" }),
      record("e01-fixedBacklog-run3", 1, "Fail"),
    ];
    const text = buildA10Result({ manifest: { manifestId: "m", manifestSha256: H }, windows, e01: { verdict: { status: "未確認" } } });
    const parsed = readSelfHashed(text, "resultSha256") as { windows: (WindowRecord & { latest: boolean })[] };
    expect(parsed.windows.map((w) => [w.id, w.attempt, w.status, w.latest])).toEqual([
      ["e01-fixedBacklog-run1", 1, "Blocked", false],
      ["e01-fixedBacklog-run1", 2, "Pass", true],
      ["e01-fixedBacklog-run2", 1, "Blocked", true],
      ["e01-fixedBacklog-run3", 1, "Fail", true],
    ]);
    expect(parsed.windows[2]).toMatchObject({ reason: "host launcher exited mid-run", childExit: { code: 1, signal: null } });
    expect(() => readSelfHashed(text.replace('"Fail"', '"Pass"'), "resultSha256")).toThrow("resultSha256 mismatch");
  });
});

describe("P2-A10-T01 runner side: 正式窓の再実行制限（ヘルツ総合レビュー 指摘 6 の再現）", () => {
  it("--manifest に予備専用オプション（--period 等）を足すと、記録先が evidence-scratch に変わる前に拒否する", () => {
    expect(() => parseArgs(["--manifest", "m.json", "--period", "1370", "--windows", "e01-fixedBacklog-run1"])).toThrow("--period is allowed only with --preliminary");
  });
  it("P3-PH-T04: split-machine options are preliminary only and --runs-root is formal too", () => {
    expect(parseArgs(["--manifest", "m.json", "--runs-root", "/r"]).args.get("runs-root")).toBe("/r");
    for (const extra of [["--chrome-cdp", "100.64.0.1:9222"], ["--display-host", "100.78.235.111"]]) {
      expect(() => parseArgs(["--manifest", "m.json", ...extra])).toThrow("is allowed only with --preliminary");
      expect(() => parseArgs(["--preliminary", ...extra])).toThrow("--chrome-cdp and --display-host go together");
    }
    expect(parseArgs(["--preliminary", "--chrome-cdp", "100.64.0.1:9222", "--display-host", "100.78.235.111"]).preliminary).toBe(true);
  });
});

describe("P2-A10-T01 runner side: 窓記録の raw（ヘルツ最終確認 指摘 2 の再現）", () => {
  it("下位 dir にある集計の入力（AC15 の full/host-obs.jsonl など）も raw に入り、checkpoint の state/ は入らない", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleq-hashraw-"));
    try {
      for (const f of ["aux-ac15.json", "full/host-obs.jsonl", "full/stringify.jsonl", "full/state/U-E-A.json", "state/U-W-A.json"]) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), f);
      }
      expect(hashRaw(dir).map((r) => r.file)).toEqual(["aux-ac15.json", "full/host-obs.jsonl", "full/stringify.jsonl"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// P3-C4 工程2d（ヘルツ節目 P2）の再発防止。
describe("P3-C4 resume and foreground checks", () => {
  it("a resume is refused when the measured commit, the build, the runner or the machine differs from the first window's record", () => {
    const first = { gitHead: "a", distSha256: "d", runnerSha256: "r", machine: { cpu: "M4", cores: 10, memoryBytes: 16 }, nodeVersion: "v22", chromeVersion: "154", osVersion: "27" };
    const records = [{ startedAt: "2026-10-08T01:00:00Z", preflight: first }, { startedAt: "2026-10-07T01:00:00Z", preflight: null }];
    expect(resumeProblems(first, records)).toEqual([]);
    expect(resumeProblems({ ...first, distSha256: "x", machine: { ...first.machine, memoryBytes: 32 } }, records).map((p) => p.split(":")[0])).toEqual(["distSha256", "machine"]);
    expect(resumeProblems({ ...first, gitHead: "b" }, [])).toEqual([]);
  });

  it("a trial whose page is hidden, unfocused or off the manifest's motion is a deviation", () => {
    const ok = { visibility: "visible", focus: true, reducedMotion: false };
    expect(trialConditionDeviation(ok, "full")).toBeNull();
    expect(trialConditionDeviation({ ...ok, visibility: "hidden" }, "full")).toMatch(/visibility hidden/);
    // OS の key window でない（hasFocus が false）だけでは逸脱にしない（Opus 適合レビュー F1。visibility の間引きの条件より厳しいため）。
    expect(trialConditionDeviation({ ...ok, focus: false }, "full")).toBeNull();
    expect(trialConditionDeviation(ok, "reduced")).toMatch(/prefers-reduced-motion/);
  });

  // 工程2d の再確認 S3・T2: 状態は投入の時点で取り、投入の時刻以降の blur・visibilitychange があれば逸脱（投入の直後、状態を取る前の blur も）。
  it("a blur or visibilitychange from the send to the end of the trial is a deviation, and one before the send is not", () => {
    const ok = { visibility: "visible", focus: true, reducedMotion: false };
    expect(trialConditionDeviation(ok, "full", [[979, "blur"]], 1000)).toBeNull();
    expect(trialConditionDeviation(ok, "full", [[979, "blur"], [1000, "blur"], [1001, "visibilitychange:hidden"]], 1000))
      .toMatch(/during the trial: blur,visibilitychange:hidden$/);
    expect(trialConditionDeviation(ok, "full", null, 1000)).toMatch(/trial watch is missing/);
  });

  // 工程2d の再確認 U1: 壁時計が試行の間に戻ると、投入の後の blur が投入より前の時刻になるので、跳びを測った試行は逸脱にする。
  it("a trial during which the wall clock stepped beyond the threshold is a deviation", () => {
    const ok = { visibility: "visible", focus: true, reducedMotion: false };
    expect(trialConditionDeviation(ok, "full", [], 1000, 20)).toBeNull();
    expect(trialConditionDeviation(ok, "full", [[950, "blur"]], 1000, 50)).toMatch(/wall clock stepped by 50ms/);
  });

  // 工程2d の再確認 U1 の残り: ページの応答を待つ時間は、時計の跳びに数えない。
  it("a slow page reply is not counted as a wall clock step", async () => {
    const sentSkewMs = Date.now() - performance.now();
    const end = await trialWatchAtEnd(() => new Promise((resolve) => setTimeout(() => resolve([]), 60)), sentSkewMs);
    expect(end.clockStepMs).toBeLessThan(20);
  });

  // 工程2d の再確認 U2: 親からの転送と端末の Ctrl-C で SIGINT が 2 回届いても、後始末は 1 回。
  it("a signal delivered twice runs the stop once", () => {
    let stops = 0;
    const stop = signalStopper(() => { stops++; });
    stop();
    stop();
    expect(stops).toBe(1);
  });

  // 工程2d の再確認 T1: 正式は作り直した直後の dist で起動したプロセスだけが測る。
  it("a formal process that was not started on a just-rebuilt dist is refused", () => {
    expect(distRebuildProblem("d", "d")).toBeNull();
    expect(distRebuildProblem(undefined, "d")).toMatch(/not rebuilt/);
    expect(distRebuildProblem("d", "e")).toMatch(/changed after the rebuild/);
  });

  // 工程2d の再確認 S1: 正式の最初の窓でも、機械（CPU・コア数・メモリ・OS・Node・Chrome）を凍結 manifest と照合する。
  it("the machine is checked against the frozen manifest, so a first window on another machine is refused", () => {
    const manifest = { nodeVersion: "v22.23.3", osVersion: "27.0.0 arm64", device: "Apple M2 x8, 8GiB", chrome: { version: "154.0.8037.98" } };
    const actual = { nodeVersion: "v22.23.3", chromeVersion: "154.0.8037.98", osVersion: "27.0.0 arm64", device: "Apple M2 x8, 8GiB" };
    expect(machineProblems(manifest, actual)).toEqual([]);
    expect(machineProblems(manifest, { ...actual, device: "Apple M5 x10, 32GiB" })).toEqual(["device is Apple M5 x10, 32GiB, the frozen manifest has Apple M2 x8, 8GiB"]);
  });

  // 実不具合（2026-10-07 の正式で母集団 5 が Blocked）: 背景の 81_01_04 と同じ subject の引き金は、背景の後すべて stale で捨てられた。
  it("the forecastDeadlineOverlap trigger office is absent from the load of forecastDeadlineOverlap", () => {
    const manifest = JSON.parse(readFileSync("reconstruction/test/eew-e01/evidence/p3/manifest.json", "utf8"));
    expect(deadlineTriggerOverlap(manifest)).toBeNull();
    expect(deadlineTriggerOverlap(manifest, "稚内地方気象台")).toMatch(/81_01_04_251222_VPWP50/);
  });
});

// 模擬の CDP（127.0.0.1）。hold に入れた method の返信は release を呼ぶまで返さない。upgrade を false にすると Upgrade に答えない。
async function mockCdp({ hold = [] as string[], upgrade = true } = {}) {
  const commands: string[] = [];
  const held = new Map<string, () => void>();
  const server = createServer((_request, response) => response.end(JSON.stringify({ Browser: "Chrome/100", webSocketDebuggerUrl: "ws://x/devtools/browser/mock" })));
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => { if (upgrade) wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws)); });
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string };
    commands.push(method);
    const result = method === "SystemInfo.getInfo" ? { commandLine: [...FLAGS, "--remote-debugging-port=0"].join(" ") }
      : method === "Browser.getVersion" ? { product: "Chrome/100" } : method === "Target.createBrowserContext" ? { browserContextId: "ctx-1" }
      : method === "Target.createTarget" ? { targetId: "page-1" } : {};
    const reply = () => ws.send(JSON.stringify({ id, result }));
    if (hold.includes(method)) held.set(method, reply); else reply();
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint: `127.0.0.1:${(server.address() as AddressInfo).port}`, commands, release: (method: string) => held.get(method)?.() };
}
const until = async (condition: () => boolean) => { while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5)); };

describe("P3-PH-AC02 remote openPage (品質レビュー P2-1・P2-2 の再現)", () => {
  it("P2-1: 開く途中に close が来たら、その後に届いた返信の context も破棄し、page を作らずに投げる", async () => {
    const cdp = await mockCdp({ hold: ["Target.createBrowserContext"] });
    const closers: (() => Promise<void>)[] = [];
    const opened = openPage("http://127.0.0.1/", { add: (f: () => Promise<void>) => closers.push(f) }, { cdp: cdp.endpoint }).then(() => "opened", (e: Error) => e.message);
    await until(() => cdp.commands.includes("Target.createBrowserContext"));
    const closing = closers[0]();
    cdp.release("Target.createBrowserContext");
    await closing;
    expect(await opened).toBe("openPage was closed while opening");
    expect(cdp.commands).toContain("Target.disposeBrowserContext");
    expect(cdp.commands).not.toContain("Target.createTarget");
  });

  it("r1 P2: page の初期化の返信待ちに close が来たら、残りの command（Page.enable 以降）を送らずに投げる", async () => {
    const cdp = await mockCdp({ hold: ["Emulation.setDeviceMetricsOverride"] });
    const closers: (() => Promise<void>)[] = [];
    const opened = openPage("http://127.0.0.1/", { add: (f: () => Promise<void>) => closers.push(f) }, { cdp: cdp.endpoint }).then(() => "opened", (e: Error) => e.message);
    await until(() => cdp.commands.includes("Emulation.setDeviceMetricsOverride"));
    const before = cdp.commands.length;
    const closing = closers[0]();
    cdp.release("Emulation.setDeviceMetricsOverride");
    await closing;
    expect(await opened).toBe("openPage was closed while opening");
    expect(cdp.commands.slice(before)).toEqual(["Target.closeTarget", "Target.disposeBrowserContext"]);
  });

  it("P2-2: Upgrade に答えない入口では、接続の確立待ちが期限（30 秒）で投げる", async () => {
    const cdp = await mockCdp({ upgrade: false });
    await expect(openPage("http://127.0.0.1/", null, { cdp: cdp.endpoint })).rejects.toThrow("Opening handshake has timed out");
  }, 45_000);
});
