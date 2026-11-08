import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostStatus } from "../../contracts/p3-cli-repl.types";
import { runRepl } from "../../src/cli/repl";

// readline の fake: 入力中の文字の欄 line と、setPrompt・prompt の記録を持つ。行を起こす口は enter（repl.test.ts の fake と違い line は欄）。
type FakeReadline = { line: string; calls: string[]; enter(text: string): void; close(): void };
const mocks = vi.hoisted(() => ({ readline: null as FakeReadline | null }));
vi.mock("node:readline", () => ({
  createInterface: () => {
    const handlers: Record<string, ((text: string) => void)[]> = {};
    let closed = false;
    const fake = {
      line: "", calls: [] as string[],
      on: (event: string, handler: (text: string) => void) => { (handlers[event] ??= []).push(handler); return fake; },
      setPrompt: (text: string) => { fake.calls.push(`setPrompt:${text}`); }, prompt: () => { fake.calls.push("prompt"); },
      close: () => { if (closed) return; closed = true; for (const handler of handlers.close ?? []) handler(""); },
      enter: (text: string) => { for (const handler of handlers.line ?? []) handler(text); },
    };
    mocks.readline = fake;
    return fake;
  },
}));

// clock の入口は promptClock を保存するので、設定の場所を一時 directory に向ける（利用者の設定に書かない）。
let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleq-prompt-"));
  vi.stubEnv("XDG_CONFIG_HOME", tmp);
  vi.useFakeTimers();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const STATUS: HostStatus = { connection: "connected", socketId: 1, failedAttempts: 0, lastFailure: null, lastFrameWallMs: null, lostConnections: 0,
  lastLossFrameWallMs: null, display: null, classifications: null };
// isTTY の output と、試験が替える promptLabel の文字・drained の真偽で REPL を起こす。
function start(tty: boolean) {
  const state = { label: "FlEq [● 00:00:01]> ", drained: true, labels: [] as string[] };
  let openDisplay: () => void = () => {};
  const host = { displayPort: null, stop: vi.fn(), reconnect: () => "connected" as const, closeDisplay: async () => "notOpen" as const, status: () => STATUS,
    openDisplay: () => new Promise<{ kind: "opened"; port: number }>((done) => { openDisplay = () => done({ kind: "opened", port: 7789 }); }) };
  const control = { setSummaryInterval: () => {}, summaryNow: () => {}, setTipInterval: () => {}, setEewLog: () => {}, clear: () => {},
    promptLabel: (mode: "elapsed" | "clock" | "uptime") => { state.labels.push(mode); return state.label; } };
  const repl = runRepl({ host, settings: { notify: {}, sound: true, mute: null, version: 0 }, savedMute: undefined, displayPort: 7789,
    clock: () => ({ wallTimeMs: Date.now(), monotonicMs: Date.now() }), onClose: () => {},
    terminal: { output: Object.assign(new Writable({ write: (_chunk, _encoding, done) => { done(); } }), { isTTY: tty }), line: () => {}, bind: () => {} },
    control, drained: () => state.drained, initial: { summaryMinutes: 0, tipMinutes: 30, clock: "elapsed", eewLog: false, eewLogFields: {} } });
  const readline = mocks.readline!;
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  return { state, repl, readline, openDisplay: () => openDisplay(), settle };
}

describe("P3-CLI-T17 入力の行（AC23、P3-CLI-D-O3-PROMPT）", () => {
  it("TTY では 1 秒ごとに文字を当て、変わったときだけ、走る command・入力中の文字・書き出しの残りが無いときに書き直す", async () => {
    const { state, repl, readline, openDisplay, settle } = start(true);
    // (a) 最初の prompt の前の setPrompt は promptLabel の文字
    expect(readline.calls).toEqual([`setPrompt:${state.label}`, "prompt"]);
    // (c) 文字が同じなら書き直さない
    readline.calls.length = 0;
    vi.advanceTimersByTime(1_000);
    expect(readline.calls).toEqual([`setPrompt:${state.label}`]);
    // (b) 文字を替えると 1 秒の内に 1 回
    state.label = "FlEq [● 00:00:03]> ";
    readline.calls.length = 0;
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(readline.calls.filter((call) => call === "prompt")).toHaveLength(1);
    // (d) 入力中の文字があれば setPrompt だけ
    state.label = "FlEq [● 00:00:05]> ";
    readline.line = "not";
    readline.calls.length = 0;
    vi.advanceTimersByTime(1_000);
    expect(readline.calls).toEqual([`setPrompt:${state.label}`]);
    readline.line = "";
    // (e) 書き出しが終わっていなければ書き直さない
    state.drained = false;
    readline.calls.length = 0;
    vi.advanceTimersByTime(1_000);
    expect(readline.calls).not.toContain("prompt");
    state.drained = true;
    // (f) display on の結果を待っている間（command が走っている）は書き直さない
    readline.enter("display on");
    await settle();
    readline.calls.length = 0;
    vi.advanceTimersByTime(1_000);
    expect(readline.calls).not.toContain("prompt");
    openDisplay();
    await settle();
    expect(readline.calls.slice(-2)).toEqual([`setPrompt:${state.label}`, "prompt"]);
    // (g) clock uptime の後の promptLabel の引数は uptime
    readline.enter("clock uptime");
    await settle();
    expect(state.labels.at(-1)).toBe("uptime");
    await repl.idle();
    // (h) close の後は時間を進めても何も呼ばない
    repl.close();
    readline.calls.length = 0;
    state.label = "FlEq [● 00:00:09]> ";
    vi.advanceTimersByTime(5_000);
    expect(readline.calls).toEqual([]);
  });

  it("TTY でない output では『FlEq> 』だけを当て、promptLabel を呼ばず、時間を進めても書き直さない", () => {
    const { state, repl, readline } = start(false);
    // (i)
    vi.advanceTimersByTime(5_000);
    expect(readline.calls).toEqual(["setPrompt:FlEq> ", "prompt"]);
    expect(state.labels).toEqual([]);
    repl.close();
  });
});
