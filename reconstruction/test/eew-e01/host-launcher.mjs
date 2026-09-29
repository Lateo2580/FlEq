// P2-A10-AC12 の観測口の受け手。子プロセスとして startP2Host を呼び、観測を 1 run 1 ファイルの JSON Lines に書く。
// 無いと、投入側と別プロセスの製品 host を測れず、runner が製品入力処理を持つことになる。
// hot path では配列に積むだけ。書き出しは tick 外の timer か終了時（WP3a と WP3b が同じ形を読む）。
//   {"t":"meta","runId","nodeVersion","startedWallMs"} は最初の 1 行
//   {"t":"obs","o":<P2HostObservation>} / {"t":"clock","hrtimeNs","perfNowMs"}（起動時と 30 秒ごと）/ {"t":"mem",...}（10 秒ごと）
import { appendFileSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { performance } from "node:perf_hooks";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));

// 通知 backend を実物のまま使うと、EventID ごとに 1 回（eew.ts の latch）OS の通知と音が出る。silent は spawn の相手だけ /usr/bin/true に替える
// （子プロセスの生成費用と close の流れは製品のまま）。実 backend の測定は config.notification === "real"。
if (config.notification === "silent") {
  const spawn = childProcess.spawn;
  childProcess.spawn = (_executable, _argv, options) => spawn("/usr/bin/true", [], options);
}
// 静的 import にしない（巻き上げで spawn の差し替えより先に host.js が読まれる）。
const { startP2Host } = await import("../../dist/src/host/host.js");

const pending = [];
let meta = null;
const flush = () => {
  if (pending.length === 0) return;
  const runId = pending.map((line) => line.o?.runId).find((id) => id != null);
  let text = "";
  if (meta == null && runId != null) {
    meta = { t: "meta", runId, nodeVersion: process.version, startedWallMs: config.startedWallMs };
    text += `${JSON.stringify(meta)}\n`;
  }
  if (meta == null) return; // runId が分かるまで（起動の初期 snapshot まで）保留する
  text += pending.splice(0).map((line) => JSON.stringify(line)).join("\n") + "\n";
  appendFileSync(config.obsPath, text);
};
const clockLine = () => {
  const hrtimeNs = process.hrtime.bigint().toString();
  pending.push({ t: "clock", hrtimeNs, perfNowMs: performance.now() });
};
const clock = () => {
  const monotonicMs = performance.now();
  return { wallTimeMs: config.wallOriginMs + Math.trunc(monotonicMs), monotonicMs };
};

clockLine();
const host = await startP2Host({ wsUrl: config.wsUrl, stateDirectory: config.stateDirectory, diagnosticDirectory: config.diagnosticDirectory,
  displayPort: 0, clock, observe: (o) => { pending.push({ t: "obs", o }); } });
// host 起動直後の mem 行（10 秒周期とは別）。E05/E12 が「区間の開始以前で最後の mem 行」を前値に使う。
const memLine = () => {
  const m = process.memoryUsage();
  pending.push({ t: "mem", perfNowMs: performance.now(), rss: m.rss, heapUsed: m.heapUsed, external: m.external });
};
memLine();
const timers = [
  setInterval(flush, 250),
  setInterval(clockLine, 30_000),
  setInterval(memLine, 10_000),
];

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  timers.forEach(clearInterval);
  // 停止直前の mem 行。E12/E05 が「区間の終了以後で最初の mem 行」を後値に使う。
  memLine();
  try { await host.stop(); } catch { /* host の終了失敗は run 側が obs と exit code で見る */ }
  clockLine();
  flush();
  process.exit(0);
};
process.on("message", (m) => { if (m?.t === "stop") void stop(); });
process.on("disconnect", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.send?.({ t: "ready", displayPort: host.displayPort });
