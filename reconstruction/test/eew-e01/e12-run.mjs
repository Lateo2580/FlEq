// A10 WP3b E12（AC08）: 同じ frames.jsonl を、旧側(legacy launcher)と新側(WS → host launcher)へ別実行で流し、GC/heap を報告する。
// 両方 `node --heap-prof --heap-prof-dir=<run別>` + probe-preload で起動し、同じ Node（process.execPath）を使う。
//
// usage: node e12-run.mjs --out <run dir> [--eew 30 --interval-ms 200] [--launcher host-launcher.mjs]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

import { E12_CONFIG_NOTE, bracketMem, parseFlags, parseJsonl, replayInterval, summarizeReplayWindow } from "./aux-measures.mjs";

const here = import.meta.dirname;
const repoRoot = resolve(here, "../../..");
const fixture = (name) => readFileSync(join(repoRoot, "test/fixtures", name), "utf8");

// dmdata 形式の frame。旧 handler が読む xmlReport と、新 ingress が読む head/encoding の両方を満たす（replay-bench の組み方に倣う）。
// 本文は utf-8・無圧縮（旧 handler は utf-8 本文を読める: telegram-body.ts）。gunzip の費用は旧新とも入らない。
function frame(xml, headType, classification, meta) {
  const now = "2024-06-13T00:00:00.000Z";
  return JSON.stringify({ type: "data", version: "2.0", classification, id: `e12-${headType}-${meta.serial ?? 0}`,
    passing: [{ name: "e12", time: now }], head: { type: headType, author: "気象庁", time: now, test: false, xml: true },
    xmlReport: { control: { title: meta.title, dateTime: now, status: "通常", editorialOffice: "気象庁本庁", publishingOffice: "気象庁" },
      head: { title: meta.title, reportDateTime: now, targetDateTime: now, eventId: meta.eventId, serial: meta.serial, infoType: "発表",
        infoKind: meta.infoKind, infoKindVersion: "1.0_0", headline: null } },
    format: "xml", compression: null, encoding: "utf-8", body: xml });
}

// EEW 続報 N 件 + 中ほどに最大 XML(VPWS50) 1 件。
export function buildFrames({ eew, intervalMs }) {
  const eewXml = fixture("77_01_01_240613_VXSE45.xml");
  const lines = [];
  for (let serial = 1; serial <= eew; serial++) {
    lines.push({ atMs: serial * intervalMs, frame: frame(eewXml.replace("<Serial>1</Serial>", `<Serial>${serial}</Serial>`), "VXSE45", "eew.forecast",
      { title: "緊急地震速報（地震動予報）", eventId: "20240417231454", serial: String(serial), infoKind: "緊急地震速報" }) });
  }
  lines.splice(Math.floor(eew / 2), 0, { atMs: (Math.floor(eew / 2) + 0.5) * intervalMs, frame: frame(fixture("15_18_01_250630_VPWS50.xml"), "VPWS50",
    "telegram.weather", { title: "全国気象警報・注意報", eventId: null, serial: null, infoKind: "気象警報・注意報" }) });
  return lines;
}

const nodeArgs = (runDir, ...rest) => ["--heap-prof", `--heap-prof-dir=${runDir}`, "--import", join(here, "probe-preload.mjs"), ...rest];

// 子は必ず ipc 付きで起動し、終了は {t:"stop"} → 期限(10 秒)後 SIGKILL。生きている子は live に持ち、signal・例外でも止める。
const STOP_DEADLINE_MS = 10_000;
const live = new Set();
function launch(runDir, args) {
  const child = spawn(process.execPath, nodeArgs(runDir, ...args), { env: { ...process.env, FLEQ_PROBE_OUT: join(runDir, "probe.json") }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
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
    await new Promise((wake) => setTimeout(wake, 500));
    return { exit: await stopChild(run) };
  } finally {
    await stopChild(run);
    await new Promise((done) => server.close(done));
  }
}

if (process.argv[1] != null && import.meta.filename === process.argv[1]) {
  const values = parseFlags(process.argv.slice(2));
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const lines = buildFrames({ eew: Number(values.eew ?? 30), intervalMs: Number(values["interval-ms"] ?? 200) });
  const framesFile = join(out, "frames.jsonl");
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(framesFile, text);
  const report = { schemaVersion: "p2-e12-report-v1", nodeVersion: process.version, framesSha256: createHash("sha256").update(text).digest("hex"),
    frames: lines.length, configuration: E12_CONFIG_NOTE };
  const read = (side, name) => JSON.parse(readFileSync(join(out, side, name), "utf8"));
  // FLEQ_PROBE_OUT を指定したのに probe.json が無い子は未確認（GC を比較に使えない）。
  const noProbe = (side, exit) => (existsSync(join(out, side, "probe.json")) ? null : { exit, status: "未確認", reason: "probeMissing" });
  const { exit: oldExit } = await runOld(join(out, "old"), framesFile);
  // replay 区間 = 最初の投入〜最後の処理完了。旧側は launcher 自身が取った前後の memoryUsage を使う。
  if ((report.old = noProbe("old", oldExit)) == null) try {
    const calls = read("old", "calls.json");
    const last = calls.calls.at(-1);
    report.old = { exit: oldExit, ...summarizeReplayWindow({ probe: read("old", "probe.json"), startMs: calls.calls[0].startedMs, endMs: last.startedMs + last.durationMs,
      before: calls.memBefore, after: calls.memAfter }) };
  } catch { report.old = { exit: oldExit, status: "未確認", reason: "summaryFailed" }; }
  const { exit: newExit } = await runNew(join(out, "new"), framesFile, values.launcher ?? join(here, "host-launcher.mjs"));
  // 新側は区間の開始以前で最後・終了以後で最初の launcher の mem 行を使う（符号付き距離を出し、無い/区間より遠ければ未確認）。
  if ((report.new = noProbe("new", newExit)) == null) try {
    const records = parseJsonl(readFileSync(join(out, "new", "host.jsonl"), "utf8"));
    const interval = replayInterval(records);
    report.new = { exit: newExit, ...summarizeReplayWindow({ probe: read("new", "probe.json"), ...interval,
      ...bracketMem(records, interval.startMs, interval.endMs) }) };
  } catch { report.new = { exit: newExit, status: "未確認", reason: "summaryFailed" }; }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
