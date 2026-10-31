import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostCommandPort } from "../../contracts/p3-cli-repl.types";
import { runCli } from "../../src/cli/cli";

type FakeReadline = { line(text: string): void; close(): void };
const mocks = vi.hoisted(() => ({ startP2Host: vi.fn(), exchange: vi.fn(), answers: [] as (string | (() => string))[], readline: null as FakeReadline | null }));
vi.mock("../../src/host/host", () => ({ startP2Host: mocks.startP2Host }));
vi.mock("../../src/host/dmdata-rest", () => ({ exchange: mocks.exchange }));
// T07 の question の答え方はそのまま。REPL（T12）が使う on・setPrompt・prompt と、行と close を試験から起こす口を足した。
vi.mock("node:readline", () => ({
  createInterface: () => {
    const handlers: Record<string, ((text: string) => void)[]> = {};
    let closed = false;
    const fake = {
      question: (_prompt: string, answer: (text: string) => void) => { const next = mocks.answers.shift() ?? ""; answer(typeof next === "function" ? next() : next); },
      on: (event: string, handler: (text: string) => void) => { (handlers[event] ??= []).push(handler); return fake; },
      setPrompt: () => {}, prompt: () => {},
      close: () => { if (closed) return; closed = true; for (const handler of handlers.close ?? []) handler(""); },
      line: (text: string) => { for (const handler of handlers.line ?? []) handler(text); },
    };
    mocks.readline = fake;
    return fake;
  },
}));
// T12 (d)(e): 設定の書き込みを rename の前（一時 file の書き込み）か、rename の後の directory の sync で止める。gate を開けるまで待つ。
const writes = vi.hoisted(() => ({ stall: null as "write" | "directorySync" | null, reached: false, release: () => {}, gate: Promise.resolve() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const [, flags] = args;
    if (writes.stall === "write" && flags === "wx") {
      const writeFile = handle.writeFile.bind(handle);
      return Object.assign(handle, { writeFile: async (...rest: Parameters<typeof writeFile>) => { writes.reached = true; await writes.gate; return writeFile(...rest); } });
    }
    if (writes.stall === "directorySync" && flags === "r") {
      const sync = handle.sync.bind(handle);
      return Object.assign(handle, { sync: async () => { writes.reached = true; await writes.gate; return sync(); } });
    }
    return handle;
  };
  return { ...actual, open };
});

const REPO = join(__dirname, "../../..");
const FLEQ = join(REPO, "reconstruction/cli/fleq.mjs");
const VXSE52 = "test__fixtures__32-35_01_02_240613_VXSE52";
let tmp = "";
let stdout = "";
let stderr = "";
const configFile = () => join(tmp, "fleq-next", "config.json");
const legacyDirectory = () => join(tmp, "fleq");
const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), "utf8"));
const writeAt = (directory: string, value: unknown) => { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "config.json"), JSON.stringify(value)); };
const clear = () => { stdout = ""; stderr = ""; };
const sigintListeners = () => process.listeners("SIGINT");
// CLI が足した listener だけを直接呼ぶ（process.emit は vitest の handler も起こす）。
const fire = (before: readonly unknown[]) => sigintListeners().filter((listener) => !before.includes(listener)).forEach((listener) => listener("SIGINT"));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleq-cli-"));
  vi.stubEnv("XDG_CONFIG_HOME", tmp);
  vi.stubEnv("DMDATA_API_KEY", undefined);
  clear();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
  mocks.startP2Host.mockReset();
  mocks.exchange.mockReset();
  mocks.answers.length = 0;
  writes.stall = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("P3-CLI-REPL-001 発注 1", () => {
  // P3-CLI-T01 acceptance (AC03・AC08)
  it("config は旧築と別の directory に 0600 で書き、apiKey を伏せて見せ、region を持つ", async () => {
    const listeners = [sigintListeners().length, process.listenerCount("SIGTERM")];
    expect(await runCli(["config", "path"])).toBe(0);
    expect(stdout.trim()).toBe(configFile());
    for (const [key, value] of [["apiKey", "abcdefgh1234"], ["appName", "fleq-new-test"], ["classifications", "telegram.earthquake,eew.forecast"],
      ["displayPort", "7790"], ["region", "栃木県宇都宮市"], ["regionScope", "regionOnly"]]) expect(await runCli(["config", "set", key, value])).toBe(0);
    clear();
    expect(await runCli(["config", "show"])).toBe(0);
    expect(stdout).toContain("apiKey = abcd****1234");
    expect(stdout).toContain("region = 栃木県宇都宮市");
    expect(stdout).toContain("regionScope = regionOnly");
    expect(readConfig()).toMatchObject({ classifications: ["telegram.earthquake", "eew.forecast"], displayPort: 7790 });
    if (process.platform !== "win32") {
      expect(statSync(configFile()).mode & 0o777).toBe(0o600);
      expect(statSync(join(tmp, "fleq-next")).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(tmp, "fleq-next")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await runCli(["config", "unset", "region"])).toBe(0);
    clear();
    await runCli(["config", "show"]);
    expect(stdout).not.toContain("region = ");
    clear();
    expect(await runCli(["config", "keys"])).toBe(0);
    const keys = stdout.split("\n").filter((line) => /^\S/.test(line) && !line.endsWith(":"));
    expect(keys).toHaveLength(15);
    expect(stdout).not.toMatch(/backup|tableWidth/);
    expect(stdout).toContain("sound\n  通知音の有効/無効 (true/false)\n");
    expect([sigintListeners().length, process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  // P3-CLI-T02 contractBoundary (AC09・AC02・AC03)
  it("無効な入力は 1 と理由だけで、何も作らず書かず host を呼ばない", async () => {
    const rejected = async (...argv: string[]) => { clear(); expect(await runCli(argv), argv.join(" ")).toBe(1); expect(stderr, argv.join(" ")).not.toBe(""); };
    await rejected("-c", "telegram.earthquake,foo");
    await rejected("-c", " , ");
    await rejected("--display-bind", "::1");
    vi.stubEnv("DMDATA_API_KEY", "env-key-1234"); // 下位の出どころに有効な鍵があっても、明示した空白だけの -k は拒否する
    await rejected("-k", "  ");
    expect(stderr).toContain("空白だけでない文字列"); // appName の欠けではなく、-k の検査で断られたこと
    vi.stubEnv("DMDATA_API_KEY", undefined);
    await rejected("config", "set", "displayPort", "7e3");
    await rejected("config", "set", "backup", "true");
    await rejected("config", "set", "appName", "あいうえおかきくけ");
    expect(existsSync(join(tmp, "fleq-next"))).toBe(false);
    writeAt(legacyDirectory(), { apiKey: "legacy-key-1234" });
    await rejected("config", "set", "displayPort", "70000");
    expect(existsSync(join(tmp, "fleq-next"))).toBe(false);
    writeAt(join(tmp, "fleq-next"), { apiKey: 1 });
    const before = readFileSync(configFile());
    await rejected("config", "show");
    expect(readFileSync(configFile()).equals(before)).toBe(true);
    expect(mocks.startP2Host).not.toHaveBeenCalled();
  });

  // P3-CLI-T03 acceptance (AC04)
  it("今までの fleq の設定は読むだけで、写す key だけを新しい file に 1 回で書く", async () => {
    writeAt(legacyDirectory(), { apiKey: "legacy-key-1234", appName: "fleq-mac", classifications: ["telegram.earthquake", "foo", "telegram.earthquake"], backup: true,
      tableWidth: 80, notify: { weather: true, bogus: true, tsunami: "x" }, displayHost: "0.0.0.0", displayPort: 8000, displayToken: "t12345678" });
    const legacy = join(legacyDirectory(), "config.json");
    chmodSync(legacy, 0o644);
    const before = { bytes: readFileSync(legacy), mode: statSync(legacy).mode, mtime: statSync(legacy).mtimeMs, names: readdirSync(legacyDirectory()) };
    expect(await runCli(["config", "show"])).toBe(0);
    expect(readConfig()).toEqual({ apiKey: "legacy-key-1234", classifications: ["telegram.earthquake"], notify: { weather: true } });
    expect(stderr).toMatch(/写さなかった key: .*appName.*backup.*displayPort/);
    expect(readFileSync(legacy).equals(before.bytes)).toBe(true);
    expect([statSync(legacy).mode, statSync(legacy).mtimeMs, readdirSync(legacyDirectory())]).toEqual([before.mode, before.mtime, before.names]);
    clear();
    await runCli(["config", "show"]);
    expect(stderr).not.toContain("写しました");
    expect(await runCli(["config", "set", "appName", "fleq-mac"])).toBe(1);
  });

  // P3-CLI-T04 acceptance (AC05・AC06)
  it("通常起動は引数＞環境変数＞設定の順で host を起こし、終了の要求を code にする", async () => {
    writeAt(join(tmp, "fleq-next"), { apiKey: "k0", appName: "fleq-new-test", testMode: "only" });
    vi.stubEnv("DMDATA_API_KEY", "k1");
    const stop = vi.fn(async () => ({ code: 3 }));
    const listeners = [sigintListeners().length, process.listenerCount("SIGTERM")];
    let requests = 1;
    const start = async (...argv: string[]) => {
      clear();
      mocks.startP2Host.mockResolvedValue({ displayPort: 12345, stop });
      const before = sigintListeners();
      const result = runCli(argv);
      await vi.waitFor(() => expect(stdout).toContain("受信を始めました"));
      for (let count = 0; count < requests; count += 1) fire(before);
      return result;
    };
    expect(await start("-c", "eew.forecast,eew.forecast", "--test", "including")).toBe(3);
    expect(mocks.startP2Host.mock.calls[0][0]).toMatchObject({ dmdata: { apiKey: "k1", appName: "fleq-new-test", classifications: ["eew.forecast"], testMode: "including" },
      displayPort: null, stateDirectory: join(tmp, "fleq-next", "state"), diagnosticDirectory: join(tmp, "fleq-next", "diag") });
    expect(await start("-k", "k2")).toBe(3);
    expect(mocks.startP2Host.mock.calls[1][0]).toMatchObject({ dmdata: { apiKey: "k2", testMode: "only" } });
    // (a) startP2Host が戻る前の要求は、戻った直後に stop を 1 回呼ぶ
    stop.mockClear();
    clear();
    let resolveHost: (value: unknown) => void = () => {};
    mocks.startP2Host.mockReturnValue(new Promise((resolve) => { resolveHost = resolve; }));
    const before = sigintListeners();
    const early = runCli([]);
    await vi.waitFor(() => expect(mocks.startP2Host).toHaveBeenCalledTimes(3));
    fire(before);
    resolveHost({ displayPort: 12345, stop });
    expect(await early).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stdout).not.toContain("受信を始めました");
    // (b) 戻った後は 2 回呼んでも stop は 1 回
    stop.mockClear();
    requests = 2;
    expect(await start()).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
    // (c) 認証の失敗は認証の文だけで、鍵を出さない
    clear();
    mocks.startP2Host.mockRejectedValue(new Error("dmdata authentication rejected"));
    expect(await runCli([])).toBe(1);
    expect(stderr).toContain("認証に失敗しました");
    expect(stderr + stdout).not.toContain("k1");
    // (d) appName の無い設定は host を呼ばない
    writeAt(join(tmp, "fleq-next"), { apiKey: "k0" });
    mocks.startP2Host.mockClear();
    expect(await runCli([])).toBe(1);
    expect(mocks.startP2Host).not.toHaveBeenCalled();
    expect([sigintListeners().length, process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  // P3-CLI-T12 acceptance (AC18・AC19・AC05)
  // stop は要約の code だけを返す（T04 と同じ）。
  const fakeHost = (stop: () => Promise<{ code: number }>): Omit<HostCommandPort, "stop"> & { stop: () => Promise<{ code: number }> } => ({
    displayPort: null, stop, reconnect: () => "connected", openDisplay: async () => ({ kind: "failed" }), closeDisplay: async () => "notOpen",
    status: () => ({ connection: "connected", socketId: null, failedAttempts: 0, display: null }) });
  const startRepl = async (code: number) => {
    clear();
    const stop = vi.fn(async () => ({ code }));
    mocks.startP2Host.mockResolvedValue(fakeHost(stop));
    const before = sigintListeners();
    const result = runCli([]);
    await vi.waitFor(() => expect(stdout).toContain("受信を始めました"));
    return { stop, result, before };
  };

  it("通常起動は門と displayPort null を渡して REPL を起こし、quit・close は 1 つの終了の要求で、保存を待って戻る", async () => {
    writeAt(join(tmp, "fleq-next"), { apiKey: "k0", appName: "fleq-new-test" });
    const listeners = [sigintListeners().length, process.listenerCount("SIGTERM")];
    let { stop, result, before } = await startRepl(3);
    expect(mocks.startP2Host.mock.calls[0][0]).toMatchObject({ displayPort: null });
    expect(typeof mocks.startP2Host.mock.calls[0][0].notificationGate).toBe("function");
    expect(stdout).toContain("help でコマンドの一覧");
    // (a) quit は stop を 1 回呼び、要約の code で戻る
    mocks.readline!.line("quit");
    expect(await result).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
    // (b) readline の close の後に SIGINT が来ても stop は 1 回
    ({ stop, result, before } = await startRepl(3));
    mocks.readline!.close();
    fire(before);
    expect(await result).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
    // (c) 保存が終わる前の quit でも、rename の後に戻る
    ({ result } = await startRepl(3));
    mocks.readline!.line("notify eew off");
    mocks.readline!.line("quit");
    expect(await result).toBe(3);
    expect(readConfig()).toEqual({ apiKey: "k0", appName: "fleq-new-test", notify: { eew: false } });
    expect([sigintListeners().length, process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  it("保存が期限までに終わらなければ、stop の後 5 秒で確かめられない旨を出し、code 0 を 1 にする", async () => {
    for (const stall of ["write", "directorySync"] as const) {
      writeAt(join(tmp, "fleq-next"), { apiKey: "k0", appName: "fleq-new-test" });
      writes.stall = stall;
      writes.reached = false;
      writes.gate = new Promise<void>((done) => { writes.release = done; });
      const { result } = await startRepl(0);
      // vi.waitFor（startRepl）が終わってから入れる。以後の fake の timer は stop の後の 5 秒だけ（REPL も保存も timer を使わない）。
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mocks.readline!.line("notify eew off");
      mocks.readline!.line("quit");
      while (!writes.reached || vi.getTimerCount() === 0) await new Promise((done) => setImmediate(done));
      vi.advanceTimersByTime(4_999);
      await new Promise((done) => setImmediate(done));
      expect(stderr, stall).toBe("");
      vi.advanceTimersByTime(1);
      expect(await result, stall).toBe(1);
      expect(stderr, stall).toBe(`設定ファイル ${configFile()} に最後の変更を保存できたか確かめられません\n`);
      // rename の後で止めたときは、file はもう新しい中身（文は次の起動の値を言い切らない）。
      if (stall === "directorySync") expect(readConfig()).toMatchObject({ notify: { eew: false } });
      writes.release();
      writes.stall = null;
      vi.useRealTimers();
      await vi.waitFor(() => expect(readConfig()).toMatchObject({ notify: { eew: false } }));
      await vi.waitFor(() => expect(readdirSync(join(tmp, "fleq-next")).filter((name) => name.endsWith(".tmp"))).toEqual([]));
    }
  });

  // P3-CLI-T06 acceptance (AC01・AC02)
  it("fleq.mjs は版・案内・未知の option・replay の振り分けを子プロセスで返す", () => {
    const empty = mkdtempSync(join(tmp, "cwd-"));
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: tmp };
    delete env.DMDATA_API_KEY;
    const run = (...args: string[]) => spawnSync("node", [FLEQ, ...args], { cwd: empty, env, encoding: "utf8", timeout: 60_000 });
    const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
    const a = run("--version");
    expect([a.status, a.stdout.trim()]).toEqual([0, version]);
    const b = run("--help");
    expect(b.status).toBe(0);
    for (const word of ["-k", "-c", "--test", "--summary-interval", "--display ", "--display-port", "--display-bind", "--display-token", "--debug", "init", "config", "replay"])
      expect(b.stdout, word).toContain(word);
    for (const word of ["--night", "--mode", "--filter", "--keep-existing"]) expect(b.stdout, word).not.toContain(word);
    const c = run("--night");
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("unknown option");
    const occupied = join(tmp, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "x");
    const d = run("replay", "--out", occupied, VXSE52);
    expect(d.status).toBe(1);
    expect(d.stdout).toBe("");
    expect(JSON.parse(d.stderr.trim())).toHaveProperty("error");
    expect(readdirSync(occupied)).toEqual(["keep.txt"]);
  }, 70_000);

  // P3-CLI-T07 acceptance (AC07・AC04)
  it("init は 5 段で聞き、不正な答えを聞き直し、保存の Y のときだけ移行の分も 1 回で書く", async () => {
    mocks.exchange.mockResolvedValue({ kind: "answered", status: 200, bytes: new Uint8Array(), date: null, retryAfter: null, contentType: "application/json",
      text: JSON.stringify({ items: [{ classification: "telegram.earthquake", isValid: true }, { classification: "eew.forecast", isValid: false }] }) });
    mocks.answers.push("k1234567890", "fleq", "fleq-new-test", "9", "", "", "Y");
    expect(await runCli(["init"])).toBe(0);
    expect(readConfig()).toEqual({ apiKey: "k1234567890", appName: "fleq-new-test", classifications: ["telegram.earthquake"], testMode: "no" });
    rmSync(join(tmp, "fleq-next"), { recursive: true });
    writeAt(legacyDirectory(), { apiKey: "k0legacy1234", appName: "fleq-mac", sound: false });
    mocks.answers.push("", "fleq-mac", "fleq-new-test", "", "", "n");
    clear();
    expect(await runCli(["init"])).toBe(0);
    expect(existsSync(join(tmp, "fleq-next"))).toBe(false);
    mocks.answers.push("", "fleq-mac", "fleq-new-test", "", "", "Y");
    clear();
    expect(await runCli(["init"])).toBe(0);
    expect(readConfig()).toMatchObject({ apiKey: "k0legacy1234", sound: false, appName: "fleq-new-test" });
    expect(stdout.split("今までの fleq と同じ接続名は使えません")).toHaveLength(2);
    // (d) 対話の途中で別の端末が保存したら、Y でも上書きせず code 1（途中の変更を消さない）
    rmSync(join(tmp, "fleq-next"), { recursive: true });
    mocks.answers.push("", "fleq-new-test", "", "", () => { writeAt(join(tmp, "fleq-next"), { apiKey: "other-terminal" }); return "Y"; });
    clear();
    expect(await runCli(["init"])).toBe(1);
    expect(stderr).toContain("途中で変わりました");
    expect(stderr).not.toContain("写しました");
    expect(readConfig()).toEqual({ apiKey: "other-terminal" });
  });
});
