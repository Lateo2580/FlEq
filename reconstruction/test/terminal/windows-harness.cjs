// P3-TW-T01・T02: process.platform を win32 に替えて dist の端末の出力を動かす。macOS と Linux でも子の経路を通す。
const { readFileSync, writeSync } = require("node:fs");
const { join } = require("node:path");
const workerThreads = require("node:worker_threads");

workerThreads.Worker = class { constructor() { throw new Error("worker must not start on win32"); } };
Object.defineProperty(process, "platform", { value: "win32" });
const { createTerminalOutput } = require(join(__dirname, "../../dist/src/terminal/output.js"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function ordered() {
  const reply = JSON.parse(readFileSync(0, "utf8"));
  const terminal = createTerminalOutput();
  terminal.line("一行目");
  terminal.sink.inputDone(reply);
  terminal.line("最後の行");
  // 子の起動を close の 1 秒の外で待つ（CI の起動の遅さで書き残しを捨てないため）。
  for (let waited = 0; !terminal.drained() && waited < 20_000; waited += 10) await sleep(10);
  await terminal.close();
}

async function stalled() {
  const terminal = createTerminalOutput();
  let longestGapMs = 0, last = performance.now();
  const tick = setInterval(() => { const now = performance.now(); longestGapMs = Math.max(longestGapMs, now - last); last = now; }, 10);
  // 1 単位は 1 MiB の内。総量 4 MiB で pipe を満たす。
  for (let index = 0; index < 128; index += 1) terminal.line("x".repeat(32 * 1024));
  await sleep(1_500);
  const pending = !terminal.drained();
  const started = performance.now();
  await terminal.close();
  clearInterval(tick);
  writeSync(2, JSON.stringify({ pending, closeMs: performance.now() - started, longestGapMs }));
}

(process.argv[2] === "stalled" ? stalled() : ordered()).then(() => process.exit(0));
