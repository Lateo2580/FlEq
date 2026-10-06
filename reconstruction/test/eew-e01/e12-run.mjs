// A10 WP3b E12（AC08）: 同じ frames.jsonl を、旧側(legacy launcher)と新側(WS → host launcher)へ別実行で流し、GC/heap を報告する。
// 両方 `node --heap-prof --heap-prof-dir=<run別>` + probe-preload で起動し、同じ Node（--node、既定は process.execPath）を使う。
// frame は class 別に frames.mjs の e12Frames（initial-state の規則と同じ正本）。--count は予備で件数を絞るときだけ。
//
// usage: node e12-run.mjs --out <run dir> --class <small|large|max> [--node <node>] [--count <n>] [--launcher host-launcher.mjs]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

import { E12_CONFIG_NOTE, E12_THREADS, parseFlags, parseJsonl, replayInterval, summarizeE12New, summarizeReplayWindow, waitInputsDone } from "./aux-measures.mjs";
import { e12Frames } from "./frames.mjs";

const here = import.meta.dirname;
let nodePath = process.execPath; // 旧新の子を起動する Node（run.mjs は Node 22 を --node で渡す。無いと runner の Node で走り manifest.nodeVersion と食い違う）

const nodeArgs = (runDir, ...rest) => ["--heap-prof", `--heap-prof-dir=${runDir}`, "--import", join(here, "probe-preload.mjs"), ...rest];

// 子は必ず ipc 付きで起動し、終了は {t:"stop"} → 期限(10 秒)後 SIGKILL。生きている子は live に持ち、signal・例外でも止める。
const STOP_DEADLINE_MS = 10_000;
const live = new Set();
function launch(runDir, args) {
  const child = spawn(nodePath, nodeArgs(runDir, ...args), { env: { ...process.env, FLEQ_PROBE_OUT: join(runDir, "probe.json") }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exit = new Promise((done) => child.once("exit", (code, signal) => { live.delete(child); done({ code, signal }); }));
  live.add(child);
  return { child, exit };
}
async function stopChild({ child, exit }) {
  if (live.has(child)) {
    try { child.send({ t: "stop" }); } catch { /* channel already closed: the exit or the deadline below decides */ }
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_DEADLINE_MS);
    await exit;
    clearTimeout(timer);
  }
  return exit;
}
const killAll = () => { for (const child of live) child.kill("SIGKILL"); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { killAll(); process.exit(130); });
// 親（run.mjs）が ipc 付きで起動したとき、親の異常終了（SIGKILL など）で IPC が切れたら孫を止めて終わる。
if (process.channel != null) process.once("disconnect", () => { killAll(); process.exit(130); });

// allocation の推定（AC08「--heap-prof で allocation 推定を取る」）: side dir の *.heapprofile（V8 sampling heap profile）ごとに、
// 木の selfSize の合計と samples[].size の合計を出す。sampling（既定の間隔 512KiB）の推定値で、V8 の既定では GC で回収済みの sample を
// 含まない（profile を書いた時点で残っていた割当の推定）。総 allocation ではない。
const ALLOCATION_METHOD = "sampling heap profile（node --heap-prof、既定の sampling 間隔）の selfSize 合計と samples[].size 合計。推定値で、GC 回収済みの sample を含まない V8 既定の扱い。プロセス全体（module 読み込みと host 起動を含む）の profile で、replay 区間に限らない。総 allocation ではない";
function allocationOf(dir) {
  const tree = (node) => node.selfSize + node.children.reduce((a, child) => a + tree(child), 0);
  return readdirSync(dir).filter((f) => f.endsWith(".heapprofile")).map((file) => {
    const bytes = readFileSync(join(dir, file));
    const profile = JSON.parse(bytes.toString("utf8"));
    return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), selfSizeSum: tree(profile.head),
      sampleSizeSum: profile.samples.reduce((a, x) => a + x.size, 0), samples: profile.samples.length };
  });
}

async function runOld(dir, framesFile) {
  mkdirSync(dir, { recursive: true });
  const run = launch(dir, [join(here, "e12-legacy-launcher.mjs"), "--frames", framesFile, "--out", join(dir, "calls.json")]);
  try { return { exit: await run.exit }; } finally { await stopChild(run); }
}

// 新側は WP3a の host-launcher.mjs を config.json 形式で起動する。notification は silent（実 backend で OS の通知と音を出さない）。
async function runNew(dir, framesFile, launcher) {
  mkdirSync(dir, { recursive: true });
  const lines = readFileSync(framesFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => server.once("listening", done));
  const now = Date.now();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ wsUrl: `ws://127.0.0.1:${server.address().port}/`, stateDirectory: join(dir, "state"),
    diagnosticDirectory: join(dir, "diag"), obsPath: join(dir, "host.jsonl"), wallOriginMs: now, startedWallMs: now, notification: "silent" }));
  const run = launch(dir, [launcher, join(dir, "config.json")]);
  try {
    const [socket] = await Promise.race([new Promise((done) => server.once("connection", (ws) => done([ws]))), run.exit.then(() => { throw new Error("host launcher exited before connecting"); })]);
    const start = performance.now();
    for (const { atMs, frame: text } of lines) {
      await new Promise((wake) => setTimeout(wake, Math.max(0, start + atMs - performance.now())));
      socket.send(text);
    }
    // 後値は対象の入力の処理が全部終わってから取る（最後の送信の 500ms 後に止めると、大型の処理が終わる前の mem 行しか残らない）。
    // 揃った後に 1.5 秒待つのは、owner の heap（deadlineDone ごと、1 秒の tick）と GC の probe（500ms ごとの書出し）が終わりの後に 1 回ずつ出るため。
    const hostRecords = () => (existsSync(join(dir, "host.jsonl")) ? parseJsonl(readFileSync(join(dir, "host.jsonl"), "utf8")) : []);
    const completed = await waitInputsDone(hostRecords, lines.length);
    await new Promise((wake) => setTimeout(wake, 1_500));
    return { exit: await stopChild(run), completed };
  } finally {
    await stopChild(run);
    await new Promise((done) => server.close(done));
  }
}

if (process.argv[1] != null && import.meta.filename === process.argv[1]) {
  const values = parseFlags(process.argv.slice(2));
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  if (values.node != null) nodePath = values.node;
  const all = e12Frames(values.class, Date.now());
  const lines = values.count == null ? all : all.slice(0, Number(values.count));
  const framesFile = join(out, "frames.jsonl");
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(framesFile, text);
  const report = { schemaVersion: "p2-e12-report-v1", class: values.class, node: nodePath, framesSha256: createHash("sha256").update(text).digest("hex"),
    frames: lines.length, configuration: E12_CONFIG_NOTE };
  const read = (side, name) => JSON.parse(readFileSync(join(out, side, name), "utf8"));
  // FLEQ_PROBE_OUT を指定したのに probe.json が無い子は未確認（GC を比較に使えない）。
  const noProbe = (side, exit) => (existsSync(join(out, side, "probe.json")) ? null : { exit, status: "未確認", reason: "probeMissing" });
  const { exit: oldExit } = await runOld(join(out, "old"), framesFile);
  try { report.nodeVersion = read("old", "calls.json").nodeVersion; } catch { report.nodeVersion = null; }
  // replay 区間 = 最初の投入〜最後の処理完了。旧側は launcher 自身が取った前後の memoryUsage を使う。
  if ((report.old = noProbe("old", oldExit)) == null) try {
    const calls = read("old", "calls.json");
    const last = calls.calls.at(-1);
    report.old = { exit: oldExit, ...summarizeReplayWindow({ probe: read("old", "probe.json"), startMs: calls.calls[0].startedMs, endMs: last.startedMs + last.durationMs,
      before: calls.memBefore, after: calls.memAfter }) };
  } catch { report.old = { exit: oldExit, status: "未確認", reason: "summaryFailed" }; }
  const { exit: newExit, completed } = await runNew(join(out, "new"), framesFile, values.launcher ?? join(here, "host-launcher.mjs"));
  // 新側は thread ごと（publisher と owner 3 本）に、区間の開始以前で最後・終了以後で最初の heap の行と、その thread の GC を使う。
  if (!completed) report.new = { exit: newExit, status: "未確認", reason: "inputsNotCompleted" };
  else if ((report.new = noProbe("new", newExit)) == null) try {
    const records = parseJsonl(readFileSync(join(out, "new", "host.jsonl"), "utf8"));
    const interval = replayInterval(records);
    const probeOf = (thread) => { const name = thread === "publisher" ? "probe.json" : `probe-${thread}.json`; return existsSync(join(out, "new", name)) ? read("new", name) : null; };
    report.new = { exit: newExit, ...interval, ...summarizeE12New(records, Object.fromEntries(E12_THREADS.map((t) => [t, probeOf(t)])), interval) };
  } catch { report.new = { exit: newExit, status: "未確認", reason: "summaryFailed" }; }
  try { report.allocation = { method: ALLOCATION_METHOD, old: allocationOf(join(out, "old")), new: allocationOf(join(out, "new")) }; }
  catch (error) { report.allocation = { method: ALLOCATION_METHOD, status: "未確認", reason: String(error?.message ?? error) }; }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  // disconnect の listener が IPC を event loop に留めるので、終わりで外す（自然終了させる）。
  process.channel?.unref();
}
