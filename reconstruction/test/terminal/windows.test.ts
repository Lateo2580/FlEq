import { fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalBatch } from "../../src/terminal/format";
import { createTerminalOutput } from "../../src/terminal/output";
import { inputDoneOf, reportOf } from "./terminal-fixture";

const fakes = vi.hoisted(() => ({
  fork: null as null | ((...args: unknown[]) => unknown),
  spawn: null as null | ((...args: unknown[]) => unknown),
  logClose: null as null | Promise<void>,
}));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real,
    fork: (...args: Parameters<typeof real.fork>) => fakes.fork == null ? real.fork(...args) : fakes.fork(...args),
    spawn: (...args: Parameters<typeof real.spawn>) => fakes.spawn == null ? real.spawn(...args) : fakes.spawn(...args) };
});
vi.mock("../../src/terminal/eew-log", () => ({ createEewLog: () => ({ set() {}, record() {}, close: () => fakes.logClose ?? Promise.resolve() }) }));

const REPO = join(__dirname, "../../..");
const HARNESS = join(__dirname, "windows-harness.cjs");
const WRITER = join(REPO, "reconstruction/dist/src/terminal/writer-child.js");
const WARNING = "端末へ書き出す子プロセスが止まったため、この端末には電文や返事を出しません\n";
const line = (text: string): TerminalBatch => ({ columns: 80, dropped: 0, units: [{ kind: "line", text }] });

type Fake = EventEmitter & { sent: unknown[]; send: (batch: unknown, done: (error: Error | null) => void) => void; kill: ReturnType<typeof vi.fn>; unref(): void; channel: { unref(): void } };
function fakeChild(sendError: Error | null = null): Fake {
  return Object.assign(new EventEmitter(), { sent: [] as unknown[], kill: vi.fn(() => true), unref() {}, channel: { unref() {} },
    send(this: Fake, batch: unknown, done: (error: Error | null) => void) { this.sent.push(batch); if (sendError != null) done(sendError); } });
}
// platform は createTerminalOutput の中で 1 回だけ読む（試験の間ずっと替えない）。
function onWindows(options: Parameters<typeof createTerminalOutput>[0] = {}) {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { return createTerminalOutput(options); } finally { Object.defineProperty(process, "platform", { value: real }); }
}
function notices() {
  const calls: unknown[][] = [];
  fakes.spawn = (...args) => { calls.push(args); const child = new EventEmitter(); return Object.assign(child, { unref() {} }); };
  return calls;
}
const settled = (promise: Promise<void>) => Promise.race([promise.then(() => true), new Promise<boolean>((done) => { setTimeout(() => done(false), 50); })]);

afterEach(() => { fakes.fork = null; fakes.spawn = null; fakes.logClose = null; });

function runHarness(mode: string, stdin: string | null) {
  const child = spawn(process.execPath, [HARNESS, mode], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.end(stdin ?? "");
  let error = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
  const exited = new Promise<number | null>((done) => { child.once("exit", done); });
  return { child, exited, error: () => error };
}

describe("P3-TW-T01・T02 子の経路（別の process で win32 に替える）", () => {
  it("T01: 行と報が子を通って fd 1 に積んだ順で出て、Worker を作らない", async () => {
    const reply = inputDoneOf("i", reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q"));
    const run = runHarness("ordered", JSON.stringify(reply));
    let out = "";
    run.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    const closed = new Promise<void>((done) => { run.child.once("close", () => { done(); }); });
    expect(await run.exited, run.error()).toBe(0);
    await closed;
    const places = ["一行目", "VXSE53", "最後の行"].map((text) => out.indexOf(text));
    expect(places.every((place) => place >= 0), out).toBe(true);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  }, 30_000);

  it("T02: 読まない pipe で未完了のバッチがあっても main は動き続け、close が子を待たずに終わる", async () => {
    const run = runHarness("stalled", null);
    expect(await run.exited, run.error()).toBe(0);
    run.child.stdout!.destroy();
    const result = JSON.parse(run.error()) as { pending: boolean; closeMs: number; longestGapMs: number };
    expect(result.pending).toBe(true);
    expect(result.closeMs).toBeLessThan(3_000);
    expect(result.longestGapMs).toBeLessThan(1_000);
  }, 30_000);
});

describe("P3-TW-T03 子の失敗と終わり（AC04・AC05）", () => {
  const lost: readonly (readonly [string, (child: Fake) => void, Error | null])[] = [
    ["外から消えた", (child) => { child.emit("exit", null, "SIGKILL"); }, null],
    ["生きたまま切れた", (child) => { child.emit("disconnect"); }, null],
    ["起動に失敗した", (child) => { child.emit("error", new Error("spawn")); }, null],
    ["send が失敗した", () => {}, new Error("closed")],
  ];
  it.each(lost)("%s: 列を捨てて数えるだけになり、知らせは 1 回で、子を kill する", (_name, happen, sendError) => {
    const child = fakeChild(sendError);
    fakes.fork = () => child;
    const calls = notices();
    const terminal = onWindows();
    terminal.line("一行目");
    happen(child);
    expect(terminal.drained()).toBe(true);
    expect(() => { terminal.line("二行目"); }).not.toThrow();
    expect(child.sent).toHaveLength(1);
    expect(child.kill).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(process.execPath);
    expect((calls[0][1] as string[])[2]).toBe(WARNING);
    expect(calls[0][2]).toEqual({ stdio: ["ignore", "ignore", "inherit"] });
    // 各経路を単独で確かめた後に exit を流す（先に流すと exit が経路を肩代わりする）。
    child.emit("exit", 1, null);
    expect(calls).toHaveLength(1);
  });

  it("fork が同期で投げても process を落とさず、知らせは 1 回", () => {
    fakes.fork = () => { throw new Error("spawn"); };
    const calls = notices();
    const terminal = onWindows();
    expect(() => { terminal.line("一行目"); }).not.toThrow();
    expect(terminal.drained()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("close は子を kill して exit を待たず、その後の exit では知らせない", async () => {
    const child = fakeChild();
    fakes.fork = () => child;
    const calls = notices();
    await onWindows().close();
    expect(child.kill).toHaveBeenCalled();
    child.emit("exit", null, "SIGTERM");
    expect(calls).toHaveLength(0);
  });

  it("close の待ちの間に子が落ちても、EEW ログが終わるまで resolve しない", async () => {
    const child = fakeChild();
    fakes.fork = () => child;
    const calls = notices();
    let finish = () => {};
    fakes.logClose = new Promise((done) => { finish = done; });
    const terminal = onWindows({ eewLog: { directory: "unused", enabled: false, fields: {} } });
    terminal.line("一行目");
    const closing = terminal.close();
    child.emit("exit", 1, null);
    expect(await settled(closing)).toBe(false);
    finish();
    expect(await settled(closing)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("P3-TW-T04 子の file（AC02）", () => {
  const start = (stdout: "pipe" | "ignore") => fork(WRITER, ["0"], { cwd: REPO, stdio: ["ignore", stdout, "ignore", "ipc"], serialization: "advanced" });
  const exited = (child: ChildProcess) => new Promise<number | null>((done) => { child.once("exit", done); });
  const answered = (child: ChildProcess, batch: TerminalBatch) => new Promise<unknown>((done) => { child.once("message", done); child.send(batch); });

  it("報と字の空の batch に done を返す", async () => {
    const child = start("ignore");
    const end = exited(child);
    expect(await answered(child, { columns: 80, dropped: 0, units: [{ kind: "report", report: reportOf("32-35_01_03_240613_VXSE53.xml", "U-Q"), prompt: null }] })).toBe("done");
    expect(await answered(child, { columns: 80, dropped: 0, units: [] })).toBe("done");
    child.disconnect();
    await end;
  });

  it.skipIf(process.platform === "win32")("SIGINT で落ちない", async () => {
    const child = start("ignore");
    const end = exited(child);
    await answered(child, line("一行目"));
    child.kill("SIGINT");
    expect(await answered(child, line("二行目"))).toBe("done");
    child.disconnect();
    await end;
  });

  it("読み手の閉じた pipe で exit 1", async () => {
    const child = start("pipe");
    const end = exited(child);
    // 子が動いていることを先に確かめる（exit 1 だけなら子の起動の失敗でも通る）。
    expect(await answered(child, { columns: 80, dropped: 0, units: [] })).toBe("done");
    child.stdout!.destroy();
    child.send(line("x".repeat(100_000)));
    expect(await end).toBe(1);
  });

  it("親が disconnect すると終わる", async () => {
    const child = start("ignore");
    const end = exited(child);
    await answered(child, line("一行目"));
    child.disconnect();
    await end;
    expect(child.connected).toBe(false);
  });
});
