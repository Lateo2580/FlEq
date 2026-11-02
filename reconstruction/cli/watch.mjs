// dmdata の代わりに WS・注入の口・1 枚のページを 1 つの port で持ち、いつもの fleq（通常起動）を子として起こす（P3-RW2-D-SHAPE）。
// 製品の起動・保存・通知・停止をそのまま使うため。watch の出力は通知配送・性能・保存の製品条件の合格に使わない（spec:650）。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { dataFrame, shiftTimestamps } from "../test/eew-e01/frames.mjs";

const BODY_LIMIT = 8 * 1024 * 1024; // P3-RW2-RES-01
const PING_MS = 30_000; // P3-RW2-DLV-01
const TYPE_EXACT = /^(V[A-Z]{3}\d{2}|WTJP\d{2})$/;
const reportMs = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)?.[1] ?? ""); // frames.mjs の ReportDateTime の読みの写し（reportMs は export が無い）
const FLEQ = fileURLToPath(new URL("./fleq.mjs", import.meta.url));

const page = (displayPort) => String.raw`<!doctype html><meta charset="utf-8"><title>fleq watch</title>
<body style="font:14px sans-serif;margin:1em;display:flex;gap:1em;flex-wrap:wrap">
<div style="flex:1 1 28em;min-width:0">
<h1>fleq watch</h1>
<div id="drop" style="border:2px dashed #888;padding:1em;margin:.5em 0">XML をここに落とす</div>
<p>種類 <input id="type" size="10" placeholder="VXSE53"></p>
<textarea id="xml" rows="14" style="width:100%"></textarea>
<p><button id="send">送る</button> <span id="result"></span></p>
<p><a href="http://127.0.0.1:${displayPort}/snapshot" target="_blank">/snapshot（地震の詳細・気象・火山はここで見る）</a></p>
</div>
<iframe src="http://127.0.0.1:${displayPort}/" style="flex:2 1 40em;height:90vh;border:1px solid #888"></iframe>
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
    const r = await fetch("/inject?type=" + encodeURIComponent($("type").value) + "&retime=1", { method: "POST", body: $("xml").value });
    const j = await r.json();
    $("result").textContent = j.sent ? "送った" : j.error === "notConnected" ? "fleq が繋がっていない" : "拒否（" + j.error + "）";
  } catch (e) { $("result").textContent = "失敗（" + e + "）"; }
};
</script>`;

const fail = (body) => process.stderr.write(`${JSON.stringify(body)}\n`);
const portOf = (name, fallback, low) => {
  const text = process.env[name] ?? String(fallback);
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  return port >= low && port <= 65535 ? port : null;
};

export async function runWatch(argv) {
  if (argv.length > 0) { fail({ error: "unexpectedArgument" }); return 1; }
  const watchPort = portOf("FLEQ_WATCH_PORT", 7792, 0);
  if (watchPort == null) { fail({ error: "portInvalid", name: "FLEQ_WATCH_PORT" }); return 1; }
  const displayPort = portOf("FLEQ_WATCH_DISPLAY_PORT", 7791, 1);
  if (displayPort == null) { fail({ error: "portInvalid", name: "FLEQ_WATCH_DISPLAY_PORT" }); return 1; }

  let port = 0;
  let current = null; // 今 frame を送る接続
  let socketId = 0;
  let pingId = 0;
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const handle = (req, res) => {
    const { origin, host } = req.headers;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "hostRejected" });
    if (origin != null && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "originRejected" });
    let url;
    try { url = new URL(req.url ?? "/", "http://x"); } catch { return json(res, 400, { error: "badRequest" }); }
    if (url.pathname === "/") {
      if (req.method !== "GET") return json(res, 405, { error: "methodNotAllowed" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(displayPort));
    }
    if (url.pathname !== "/inject") return json(res, 404, { error: "notFound" });
    if (req.method !== "POST") return json(res, 405, { error: "methodNotAllowed" });
    const type = url.searchParams.get("type");
    if (type == null) return json(res, 400, { error: "typeRequired" });
    if (!TYPE_EXACT.test(type)) return json(res, 400, { error: "typeInvalid" });
    const retimeParam = url.searchParams.get("retime");
    if (retimeParam != null && retimeParam !== "0" && retimeParam !== "1") return json(res, 400, { error: "retimeInvalid" });
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; json(res, 413, { error: "bodyTooLarge" }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      let frame;
      if (retimeParam !== "0") {
        const text = body.toString("utf8");
        const at = reportMs(text);
        if (!Number.isFinite(at)) return json(res, 400, { error: "reportDateTimeMissing" });
        // 不正な <DateTime> で shiftTimestamps が RangeError を投げる。1 件の拒否で済ませ、常駐を落とさない。
        try { frame = dataFrame(type, shiftTimestamps(text, Math.floor(Date.now() / 1000) * 1000 - at)); }
        catch { return json(res, 400, { error: "retimeFailed" }); }
      } else frame = dataFrame(type, body);
      if (current?.readyState !== WebSocket.OPEN) return json(res, 503, { error: "notConnected" });
      current.send(frame, () => {});
      json(res, 200, { sent: true, headType: type });
    });
  };

  const server = http.createServer(handle);
  const listened = await new Promise((done) => {
    server.once("error", done);
    server.listen(watchPort, "127.0.0.1", () => done(null));
  });
  if (listened != null) {
    fail(listened.code === "EADDRINUSE" ? { error: "portInUse", port: watchPort } : { error: "listenFailed", port: watchPort, message: String(listened.message ?? listened) });
    return 1;
  }
  port = server.address().port;
  // listen の後に載せる。先だと port 使用中の error が WebSocketServer 経由で未処理になり portInUse を出せない（AC02 (3)）
  // Origin 付きの upgrade はブラウザの他サイトからの接続なので拒む（ブラウザの WebSocket に CORS は効かない。host の client は Origin を付けない）。
  const wss = new WebSocketServer({ server, verifyClient: ({ req }) => req.headers.origin == null });

  const url = `http://127.0.0.1:${port}/`;
  // 子の fleq が初めて繋がってから開く（先だと右の iframe が接続できない）。無いと: 試験のたびにブラウザが開く
  let opened = false;
  const openPage = () => {
    if (opened || process.platform !== "darwin" || !process.stdin.isTTY) return;
    opened = true;
    spawn("open", [url], { stdio: "ignore" }).on("error", () => {}).unref();
  };
  wss.on("connection", (ws) => {
    openPage();
    ws.on("error", () => {});
    ws.on("message", () => {}); // host の pong などは読まずに捨てる
    if (current != null) current.terminate(); // host の接続は 1 本。新しい方が host の繋ぎ直し
    current = ws;
    ws.on("close", () => { if (current === ws) current = null; });
    socketId += 1;
    // start frame が無いと 30 秒で壁時計の根拠が unverified になる（host.ts:130）
    ws.send(JSON.stringify({ type: "start", socketId, classifications: [], time: new Date().toISOString() }), () => {});
  });
  // ping が無いと 90 秒で host が切る（host.ts:28）
  const pingTimer = setInterval(() => {
    pingId += 1;
    current?.send(JSON.stringify({ type: "ping", pingId: `watch-${pingId}` }), () => {});
  }, PING_MS);

  const directory = mkdtempSync(join(tmpdir(), "fleq-watch-"));
  mkdirSync(join(directory, "fleq-next"));
  // 規則が空の無期限 mute は全部を止め、sound:false は音を止める（鳴らすには REPL で mute off と sound on の両方）
  writeFileSync(join(directory, "fleq-next", "config.json"), JSON.stringify({
    apiKey: "watch", appName: "fleq-watch", display: true, displayPort, sound: false, mute: { until: null, rules: [] },
  }));

  const child = spawn(process.execPath, [FLEQ], {
    stdio: "inherit",
    env: { ...process.env, XDG_CONFIG_HOME: directory, FLEQ_WS_URL: `ws://127.0.0.1:${port}/` },
  });
  // SIGINT は端末の Ctrl+C が子にも届き、fleq が自分で止まる。親は無視して子の終了を待つ（P3-RW2-D-STOP）
  const forward = (name) => () => child.kill(name);
  const handlers = [["SIGINT", () => {}], ["SIGTERM", forward("SIGTERM")], ...(process.platform === "win32" ? [] : [["SIGHUP", forward("SIGHUP")]])];
  for (const [name, handler] of handlers) process.on(name, handler);

  process.stderr.write(`fleq watch: ${url}（設定と保存: ${directory}）\n`);

  const code = await new Promise((done) => {
    child.once("error", () => done(1));
    child.once("exit", (exitCode) => done(exitCode ?? 1));
  });
  clearInterval(pingTimer);
  for (const [name, handler] of handlers) process.off(name, handler);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise((closed) => { server.close(closed); server.closeAllConnections(); });
  return code;
}
