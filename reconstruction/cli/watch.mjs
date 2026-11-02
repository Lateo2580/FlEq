// 常駐して外から電文の注入を受ける口 fleq watch（P3-REPLAY-WATCH-001、replay は 1 回きりで止まるため別に持つ）。
// 注入は C17 の replay と同じ製品経路（ローカル WS -> startP2Host、frames.mjs の dataFrame、origin="replay"）を通す。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import { REPO, dataFrame, shiftTimestamps } from "../test/eew-e01/frames.mjs";

const BODY_LIMIT = 8 * 1024 * 1024; // P3-RW-RES-01: watch 自身の値
const SLOT_LIMIT = 8;
const WAIT_MS = 10_000; // P3-RW-DLV-01
const PING_MS = 30_000; // P3-RW-DLV-02
const TYPE_EXACT = /^(V[A-Z]{3}\d{2}|WTJP\d{2})$/;
const reportMs = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)?.[1] ?? ""); // frames.mjs の ReportDateTime の読み（P3-RW-AC01）の写し

class Refusal extends Error {
  constructor(reason, detail = {}) { super(reason); this.detail = detail; }
}

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
// 在ればそれ自体の realpath、無ければ親の realpath と basename（symlink の末尾・まだ無い fleq-next を外さない、P3-RW-D-STATE）
function resolved(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { /* 無い */ }
  try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
}

// 境界の検査（P3-RW-AC02）。何かを開く・作る前に全部確かめ、外れたら Refusal を投げる。順は (1)(2)(4)(3)。
async function parseAndCheck(argv) {
  const opts = { displayPort: 7791, injectPort: 7792, out: null, notify: false };
  const seen = new Set();
  const raw = {}; // port の値。検査は flag の走査の後（AC02 の (1)→(2)）
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) throw new Refusal("unexpectedArgument", { argument: arg });
    if (!["--display-port", "--inject-port", "--out", "--notify"].includes(arg)) throw new Refusal("unknownFlag", { flag: arg });
    if (seen.has(arg)) throw new Refusal("duplicateFlag", { flag: arg });
    seen.add(arg);
    if (arg === "--notify") { opts.notify = true; continue; }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Refusal("missingFlagValue", { flag: arg });
    i += 1;
    if (arg === "--out") { opts.out = resolve(value); continue; }
    raw[arg] = value;
  }
  for (const [flag, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Refusal("portInvalid", { flag, value });
    opts[flag === "--display-port" ? "displayPort" : "injectPort"] = Number(value);
  }
  for (const port of [opts.displayPort, opts.injectPort]) if (port === 7788 || port === 7789) throw new Refusal("reservedPort", { port });
  if (opts.displayPort !== 0 && opts.displayPort === opts.injectPort) throw new Refusal("portConflict", { port: opts.displayPort });
  for (const path of ["dist/src/host/host.js", "dist/src/runtime/owner-worker.js", "dist/chrome-eew/src/display/chrome-eew"]) {
    if (!existsSync(join(REPO, "reconstruction", path))) throw new Refusal("distMissing", { path: `reconstruction/${path}` });
  }
  if (opts.out != null) {
    if (!isDirectory(resolve(opts.out, ".."))) throw new Refusal("outParentMissing", { out: opts.out });
    if (existsSync(opts.out) && (!isDirectory(opts.out) || readdirSync(opts.out).length > 0)) throw new Refusal("outNotEmpty", { out: opts.out });
    const { settingsPaths } = await import("../dist/src/cli/settings.js");
    const inside = relative(resolved(settingsPaths().directory), resolved(opts.out));
    if (inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))) throw new Refusal("outIsProduction", { out: opts.out });
  }
  return opts;
}

const page = (displayPort) => String.raw`<!doctype html><meta charset="utf-8"><title>fleq watch</title>
<body style="font:14px sans-serif;max-width:48em;margin:1em auto">
<h1>fleq watch</h1>
<div id="drop" style="border:2px dashed #888;padding:1em;margin:.5em 0">XML をここに落とす</div>
<p>種類 <input id="type" size="10" placeholder="VXSE53"></p>
<textarea id="xml" rows="14" style="width:100%"></textarea>
<p><button id="send">送る</button> <span id="result"></span></p>
<p><a href="http://127.0.0.1:${displayPort}/snapshot" target="_blank">/snapshot（地震の詳細・気象・火山はここで見る）</a></p>
<script>
const $ = (id) => document.getElementById(id);
$("drop").ondragover = (e) => e.preventDefault();
$("drop").ondrop = async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  $("xml").value = await file.text();
  const m = /_(V[A-Z]{3}\d{2}|WTJP\d{2})/.exec(file.name);
  if (m) $("type").value = m[1];
};
$("send").onclick = async () => {
  $("result").textContent = "送信中";
  try {
    const r = await fetch("/inject?type=" + encodeURIComponent($("type").value), { method: "POST", body: $("xml").value });
    const j = await r.json();
    $("result").textContent = j.error ? "拒否（" + j.error + "）" : j.stopping ? "停止中" : j.timedOut ? "時間切れ（処理は続いています）"
      : j.processed && j.decoded ? "受理（" + j.inputId + "）" : "受理（読めず、" + j.inputId + "）";
  } catch (e) { $("result").textContent = "失敗（" + e + "）"; }
};
</script>`;

export async function runWatch(argv) {
  let opts;
  try { opts = await parseAndCheck(argv); }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`${JSON.stringify({ error: error.message, ...error.detail })}\n`);
    return 1;
  }

  // ── 停止の開始（P3-RW-AC08 (1)）と直列キュー（P3-RW-AC06）。状態は idle / waitingT2（active != null）/ stopping ──
  let stopping = false;
  let stopRequested = false;
  let host = null;
  let slots = 0; // 受信中 + キューで待つ注入（送信中を除く）
  let active = null;
  let current = null; // 今 frame を送る接続
  let socketId = 0;
  let pingId = 0;
  let pingTimer = null;
  let injectPort = 0;
  let displayPort = null;
  const queue = [];
  const receiving = new Set();
  const openResponses = new Set();
  const shape = (type, over) => ({ inputId: null, headType: type, processed: false, decoded: false, timedOut: false, stopping: false, ...over });
  const json = (res, status, body) => {
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  // 応答を決めるのは setImmediate の callback・10 秒の期限・停止の開始の最初の 1 つだけ。無いと processing の取り逃がしや二重応答が起きる。
  const settle = (job, over) => {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    clearImmediate(job.immediate);
    if (active === job) active = null;
    if (over.failed) job.reply(400, { error: "retimeFailed" });
    else job.reply(over.stopping ? 503 : 200, shape(job.type, { inputId: job.inputId, ...over }));
    pump();
  };
  const send = (job) => {
    if (job.sent || current?.readyState !== WebSocket.OPEN || stopping) return;
    let frame;
    // 不正な <DateTime> で shiftTimestamps が RangeError を投げる。1 件の拒否で済ませ、常駐を落とさない。
    try { frame = dataFrame(job.type, job.retime ? shiftTimestamps(job.text, Math.floor(Date.now() / 1000) * 1000 - job.reportMs) : job.body); }
    catch { return settle(job, { failed: true }); }
    job.sent = true;
    current.send(frame, () => {});
  };
  const pump = () => {
    if (active != null || stopping || queue.length === 0) return;
    const job = queue.shift();
    slots -= 1;
    Object.assign(job, { inputId: null, sent: false, t2: false, decoded: false, settled: false });
    active = job;
    job.timer = setTimeout(() => settle(job, { timedOut: true }), WAIT_MS);
    send(job);
  };
  // observe は T0・T2・processing だけを見る。全観測を積まない（P3-RW-RES-01）。
  const observe = (o) => {
    const job = active;
    if (job == null || job.settled) return;
    if (o.kind === "marker" && o.point === "T0") { if (job.sent && job.inputId == null) job.inputId = o.inputId; return; }
    if (job.inputId == null) return;
    if (o.kind === "processing" && o.measurement.inputId === job.inputId) job.decoded = true;
    else if (o.kind === "marker" && o.point === "T2" && o.inputId === job.inputId && !job.t2) {
      job.t2 = true;
      // processing は T2 と同じ message の処理で同期に出るので、次の macrotask で decoded を決める。
      job.immediate = setImmediate(() => settle(job, { processed: true, decoded: job.decoded }));
    }
  };
  const markStopping = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(pingTimer);
    if (active != null) settle(active, { stopping: true });
    for (const job of queue.splice(0)) { slots -= 1; job.settled = true; job.reply(503, shape(job.type, { stopping: true })); }
    for (const answer of [...receiving]) answer();
  };

  // ── 注入の HTTP の口（P3-RW-AC05） ──
  const inject = (req, res) => {
    let url;
    const { origin, host: hostHeader } = req.headers;
    if (hostHeader !== `127.0.0.1:${injectPort}` && hostHeader !== `localhost:${injectPort}`) return json(res, 403, { error: "hostRejected" });
    if (origin != null && origin !== `http://127.0.0.1:${injectPort}` && origin !== `http://localhost:${injectPort}`) return json(res, 403, { error: "originRejected" });
    try { url = new URL(req.url ?? "/", "http://x"); } catch { return json(res, 400, { error: "badRequest" }); }
    if (url.pathname === "/") {
      if (req.method !== "GET") return json(res, 405, { error: "methodNotAllowed" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(displayPort ?? opts.displayPort));
    }
    if (url.pathname !== "/inject") return json(res, 404, { error: "notFound" });
    if (req.method !== "POST") return json(res, 405, { error: "methodNotAllowed" });
    const type = url.searchParams.get("type");
    if (type == null) return json(res, 400, { error: "typeRequired" });
    if (!TYPE_EXACT.test(type)) return json(res, 400, { error: "typeInvalid" });
    const retimeParam = url.searchParams.get("retime");
    if (retimeParam != null && retimeParam !== "0" && retimeParam !== "1") return json(res, 400, { error: "retimeInvalid" });
    if (stopping) return json(res, 503, shape(type, { stopping: true }));
    if (slots >= SLOT_LIMIT) return json(res, 503, { error: "queueFull" });
    // 枠は本文を読む前に取る。無いと並列に投げる道具が 8 MiB の本文を際限なく抱える。
    slots += 1;
    let held = true;
    const release = () => { if (held) { held = false; slots -= 1; } };
    const answer = () => json(res, 503, shape(type, { stopping: true }));
    receiving.add(answer);
    openResponses.add(res);
    res.on("close", () => { release(); receiving.delete(answer); openResponses.delete(res); });
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; release(); json(res, 413, { error: "bodyTooLarge" }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      receiving.delete(answer);
      if (tooLarge || res.writableEnded) return;
      const body = Buffer.concat(chunks);
      const retime = retimeParam !== "0";
      const text = retime ? body.toString("utf8") : "";
      const at = retime ? reportMs(text) : 0;
      if (retime && !Number.isFinite(at)) { release(); return json(res, 400, { error: "reportDateTimeMissing" }); }
      if (stopping) { release(); return json(res, 503, shape(type, { stopping: true })); }
      held = false; // 枠はキューから取り出すときに返す
      queue.push({ type, body, text, retime, reportMs: at, reply: (status, out) => json(res, status, out) });
      pump();
    });
  };

  // ── 起動（P3-RW-AC03）。signal の listener は host の once より先に置く ──
  const signals = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])];
  let finish;
  const done = new Promise((resolveDone) => { finish = resolveDone; });
  let stopPromise = null;
  const onSignal = () => { stopRequested = true; markStopping(); if (host != null) stopPromise ??= stop(); };
  for (const name of signals) process.on(name, onSignal);
  const unlisten = () => { for (const name of signals) process.off(name, onSignal); };

  const server = http.createServer(inject);
  const closeInjection = async () => {
    // 返した応答が flush される前に closeAllConnections で切ると 503 が届かない。
    const flushed = Promise.all([...openResponses].map((res) => res.writableFinished ? null : new Promise((closed) => res.once("close", closed))));
    const closed = new Promise((ok) => server.close(ok)); // AC08 (3): close を先に始め、flush の後で接続を切り、最後に close の完了を待つ
    await Promise.race([flushed, new Promise((giveUp) => setTimeout(giveUp, 1000).unref())]); // 読まない client で停止が止まらないように
    server.closeAllConnections();
    await closed;
  };
  const listened = await new Promise((resolveListen) => {
    server.once("error", (error) => resolveListen(error));
    server.listen(opts.injectPort, "127.0.0.1", () => resolveListen(null));
  });
  if (listened != null) {
    unlisten();
    process.stderr.write(`${JSON.stringify({ error: listened.code === "EADDRINUSE" ? "injectPortInUse" : "injectListenFailed", port: opts.injectPort, message: String(listened.message ?? listened) })}\n`);
    return 1;
  }
  injectPort = server.address().port;

  let outDirectory = opts.out;
  if (outDirectory == null) outDirectory = mkdtempSync(join(tmpdir(), "fleq-watch-"));
  else if (!isDirectory(outDirectory)) mkdirSync(outDirectory);

  // Origin 付きの upgrade はブラウザの他サイトからの接続なので拒む（ブラウザの WebSocket に CORS は効かない、P3-RW-D-GUARD）。
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient: ({ req }) => req.headers.origin == null });
  await new Promise((listening) => wss.once("listening", listening));
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    if (current != null) current.terminate();
    current = ws;
    ws.on("close", () => { if (current === ws) current = null; });
    if (stopping) return;
    socketId += 1;
    ws.send(JSON.stringify({ type: "start", socketId, classifications: [], time: new Date().toISOString() }), () => {});
    if (active != null) send(active); // 繋がるのを待っていた注入（P3-RW-D-RECONNECT）
  });
  pingTimer = setInterval(() => {
    pingId += 1;
    current?.send(JSON.stringify({ type: "ping", pingId: `watch-${pingId}` }), () => {});
  }, PING_MS);
  const closeWs = () => { for (const ws of wss.clients) ws.terminate(); wss.close(); };

  const clock = () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
  // 門は定数を返すだけ。例外を投げると鳴らす側に倒れる（P3-RW-D-NOTIFY）。
  const notificationGate = () => ({ allow: false, stage: "mute", settingsVersion: 0 });
  try {
    const { startP2Host } = await import("../dist/src/host/host.js");
    host = await startP2Host({ wsUrl: `ws://127.0.0.1:${wss.address().port}/`, origin: "replay", stateDirectory: join(outDirectory, "state"),
      diagnosticDirectory: join(outDirectory, "diag"), displayPort: opts.displayPort, clock, observe, ...(opts.notify ? {} : { notificationGate }) });
  } catch (error) {
    markStopping();
    clearInterval(pingTimer);
    await closeInjection();
    closeWs();
    unlisten();
    const detail = error?.code === "EADDRINUSE" ? { error: "displayPortInUse", port: opts.displayPort } : { error: "hostStartFailed", message: String(error?.message ?? error) };
    process.stderr.write(`${JSON.stringify({ ...detail, outDirectory })}\n`);
    return 1;
  }
  displayPort = host.displayPort;

  // ── 停止（P3-RW-AC08）──
  async function stop() {
    await closeInjection();
    const shutdown = await host.stop();
    closeWs();
    unlisten();
    process.stdout.write(`${JSON.stringify({ schemaVersion: "fleq-watch-v1", event: "stopped", shutdown })}\n`);
    finish(shutdown.code);
  }

  process.stdout.write(`${JSON.stringify({ schemaVersion: "fleq-watch-v1", event: "started", display: `http://127.0.0.1:${displayPort}/`,
    inject: `http://127.0.0.1:${injectPort}/`, ws: `ws://127.0.0.1:${wss.address().port}/`, outDirectory,
    notification: opts.notify ? "ungated" : "muted", measured: true })}\n`);
  if (stopRequested) stopPromise ??= stop();
  return done;
}
