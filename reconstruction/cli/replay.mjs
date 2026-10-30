// 検収用 replay の公開口 fleq replay <fixture...>（P3-REPLAY-CLI-001、計画 R10②。通知の無効化は P3-RP-D-SILENT）。runner の frames.mjs の投入 frame を共有し、
// C4 の正式測定と同じ製品経路（ローカル WS -> startP2Host -> /snapshot）を通す。出力は通知配送・性能・保存の製品条件の合格には使わない。
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import { REPO, dataFrame } from "../test/eew-e01/frames.mjs";

const WAIT_LIMIT_MS = 60_000;
const WAIT_STEP_MS = 200;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Refusal extends Error {
  constructor(reason, detail = {}) { super(reason); this.detail = detail; }
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

// 境界の検査はここ 1 か所（P3-RP-AC02）。副作用（directory 作成・host 起動）の前に全部確かめ、外れたら Refusal を投げる。
function parseAndCheck(argv) {
  let out = null;
  const ids = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (out != null) throw new Refusal("duplicateFlag", { flag: "--out" });
      if (value == null || value.startsWith("--")) throw new Refusal("missingFlagValue", { flag: "--out" });
      out = resolve(value);
      i += 1;
    } else if (arg.startsWith("-")) throw new Refusal("unknownFlag", { flag: arg });
    else ids.push(arg);
  }
  if (ids.length === 0) throw new Refusal("noFixtureId");
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(REPO, "reconstruction/tools/corpus/manifest.json"), "utf8")); }
  catch (error) { throw new Refusal("manifestUnreadable", { message: String(error?.message ?? error) }); }
  if (manifest == null || !Array.isArray(manifest.fixtures)) throw new Refusal("manifestShape");
  const byId = new Map(manifest.fixtures.map((row) => [row.fixtureId, row]));
  const inputs = ids.map((fixtureId) => {
    const row = byId.get(fixtureId);
    if (row == null) throw new Refusal("unknownFixtureId", { fixtureId });
    const headType = row.transport?.headType;
    if (row.role !== "telegramXml" || typeof headType !== "string" || headType === "") throw new Refusal("notReplayable", { fixtureId });
    let bytes;
    try { bytes = readFileSync(join(REPO, row.path)); } catch { throw new Refusal("sha256Mismatch", { fixtureId }); } // 読めない fixture は台帳の bytes と照合できない
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Refusal("sha256Mismatch", { fixtureId });
    return { fixtureId, sha256: row.sha256, headType, bytes, reportDateTimeRaw: row.documentTimes?.reportDateTimeRaw };
  });
  if (out != null) {
    if (!isDirectory(resolve(out, ".."))) throw new Refusal("outParentMissing", { out });
    let exists = true;
    try { statSync(out); } catch { exists = false; }
    if (exists && (!isDirectory(out) || readdirSync(out).length > 0)) throw new Refusal("outNotEmpty", { out });
  }
  return { out, inputs };
}

const fetchSnapshot = (port) => new Promise((done) => {
  const request = http.get(`http://127.0.0.1:${port}/snapshot`, { timeout: 5000 }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => { try { done(JSON.parse(body)); } catch { done(null); } });
  });
  request.on("timeout", () => request.destroy());
  request.on("error", () => done(null));
});

export async function runReplay(argv) {
  let checked;
  try { checked = parseAndCheck(argv); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`${JSON.stringify({ error: error.message, ...error.detail })}\n`);
    return 1;
  }
  const { inputs } = checked;
  let outDirectory = checked.out;
  if (outDirectory == null) outDirectory = mkdtempSync(join(tmpdir(), "fleq-replay-"));
  else if (!isDirectory(outDirectory)) mkdirSync(outDirectory);

  // 通知を実物のまま使うと OS の通知と音が出る。spawn の相手だけ /usr/bin/true に替える（子の生成と close の流れは製品のまま）。
  // shortcut: darwin・linux の backend の spawn だけを止める（win32 では adapter が spawn しない）、Windows の通知の口ができたらそこで見直す。
  const spawn = childProcess.spawn;
  childProcess.spawn = (_executable, _argv, options) => spawn("/usr/bin/true", [], options);
  try {
    // 静的 import にしない（spawn の差し替えより先に host.js が読まれるため）。
    const { startP2Host } = await import("../dist/src/host/host.js");

    let anchorWall = inputs.map((input) => Date.parse(input.reportDateTimeRaw)).find(Number.isFinite) ?? Date.now();
    const clockOrigin = anchorWall;
    let anchorMono = performance.now();
    const clock = () => { const monotonicMs = performance.now(); return { wallTimeMs: anchorWall + Math.trunc(monotonicMs - anchorMono), monotonicMs }; };

    const done = new Set();
    const observe = (o) => { if (o.kind === "marker" && o.point === "T2") done.add(o.inputId); };
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((listening) => wss.once("listening", listening));
    let socket = null;
    let closed = false;
    const connected = new Promise((opened) => wss.once("connection", (ws) => {
      socket = ws;
      ws.on("error", () => {});
      ws.on("close", () => { closed = true; });
      opened();
    }));

    let host;
    try {
      host = await startP2Host({ wsUrl: `ws://127.0.0.1:${wss.address().port}/`, origin: "replay", stateDirectory: join(outDirectory, "state"),
        diagnosticDirectory: join(outDirectory, "diag"), displayPort: 0, clock, observe });
    } catch (error) {
      wss.close();
      process.stderr.write(`${JSON.stringify({ error: "hostStartFailed", message: String(error?.message ?? error), outDirectory })}\n`);
      return 1;
    }
    await connected;
    socket.send(JSON.stringify({ type: "start", socketId: 1, classifications: [], time: new Date(clock().wallTimeMs).toISOString() }));

    const results = inputs.map((input, index) => ({ fixtureId: input.fixtureId, sha256: input.sha256, inputId: `input-${index + 1}`, processed: false }));
    for (let index = 0; index < inputs.length && !closed; index += 1) {
      const target = Date.parse(inputs[index].reportDateTimeRaw);
      if (Number.isFinite(target) && target > clock().wallTimeMs) { anchorMono = performance.now(); anchorWall = target; } // 前へだけ（P3-RP-D-CLOCK）
      socket.send(dataFrame(inputs[index].headType, inputs[index].bytes));
      const { inputId } = results[index];
      for (let waited = 0; !done.has(inputId) && !closed && waited < WAIT_LIMIT_MS; waited += WAIT_STEP_MS) await sleep(WAIT_STEP_MS);
      if (!done.has(inputId)) break;
      results[index].processed = true;
    }

    const snapshot = await fetchSnapshot(host.displayPort);
    const shutdown = await host.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    process.stdout.write(`${JSON.stringify({ schemaVersion: "fleq-replay-v1", notification: "silent", measured: true, clockOrigin, outDirectory, inputs: results, snapshot, shutdown })}\n`);
    return shutdown.code !== 0 ? shutdown.code : results.some((result) => !result.processed) ? 1 : 0;
  } finally { childProcess.spawn = spawn; }
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === import.meta.filename) {
  const code = await runReplay(process.argv.slice(2));
  process.stdout.write("", () => process.exit(code));
}
