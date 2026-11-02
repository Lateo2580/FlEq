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
import { choices, generateTelegrams } from "../tools/telegram-gen/telegram-gen.mjs";

const BODY_LIMIT = 8 * 1024 * 1024; // P3-RW2-RES-01
const GENERATE_LIMIT = 64 * 1024; // P3-RW2-RES-01
const PING_MS = 30_000; // P3-RW2-DLV-01
const TYPE_EXACT = /^(V[A-Z]{3}\d{2}|WTJP\d{2})$/;
const reportMs = (xml) => Date.parse(/<ReportDateTime>([^<]+)</.exec(xml)?.[1] ?? ""); // frames.mjs の ReportDateTime の読みの写し（reportMs は export が無い）
const FLEQ = fileURLToPath(new URL("./fleq.mjs", import.meta.url));

const FAMILIES = ["VXSE43", "VXSE45", "VXSE51", "VXSE52", "VXSE53", "VTSE41", "VTSE51", "VTSE52"];
const escHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// 区域・震央地名の選択肢は choices から分野ごとの select に埋める（P3-RW2-AC12）。選んだ分野の select だけをページの script が見せる。
const selects = (kind) => FAMILIES.flatMap((family) => {
  const list = choices(family)[kind === "place" ? "places" : "areas"];
  return list.length === 0 ? [] : [`<select id="${kind}-${family}" data-kind="${kind}" data-family="${family}" hidden>${list.map((item) => `<option value="${item.code}">${escHtml(item.name)}（${item.code}）</option>`).join("")}</select>`];
}).join("");
const INTENSITY_OPTIONS = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"].map((value) => `<option>${value}</option>`).join("");
const SCENES = [["eew3", "EEW 予報→続報→最終報"], ["eew2", "EEW 警報"], ["eewCancel", "EEW の取消"], ["quake", "震度速報→震源・震度"], ["tsunami", "津波警報"]];

const page = (displayPort) => String.raw`<!doctype html><meta charset="utf-8"><title>fleq watch</title>
<body style="font:14px sans-serif;margin:1em;display:flex;gap:1em;flex-wrap:wrap">
<div style="flex:1 1 28em;min-width:0">
<h1>fleq watch</h1>
<div id="scenes">${SCENES.map(([id, label]) => `<button type="button" data-scene="${id}">${label}</button>`).join(" ")}</div>
<form id="make" style="margin:.5em 0;padding:.5em;border:1px solid #888">
<p><label>分野 <select id="family">${FAMILIES.map((family) => `<option>${family}</option>`).join("")}</select></label> <label><input type="checkbox" id="cancel"> 取消</label></p>
<p><label>起点 <input id="originTime" size="26" placeholder="空なら今（時差つき）"></label></p>
<p><label data-field="place">震央地名 ${selects("place")}</label></p>
<p><label data-field="lat">北緯 <input id="lat" size="5"></label> <label data-field="lon">東経 <input id="lon" size="5"></label>
<label data-field="depthKm">深さ(km) <input id="depthKm" size="4"></label> <label data-field="magnitude">M <input id="magnitude" size="3"></label></p>
<p><label data-field="maxInt">最大震度 <select id="maxInt">${INTENSITY_OPTIONS}</select></label> <label data-field="area">区域 ${selects("area")}</label></p>
<p><label data-field="serial">Serial <input id="serial" size="3"></label> <label data-field="reports">続報の数 <input id="reports" size="3"></label>
<label data-field="end">終わり <select id="end"><option value="none">なし</option><option value="final">最終報</option><option value="cancel">取消</option></select></label></p>
<p><button id="makeButton">作る</button> <span id="made"></span></p>
</form>
${process.env.FLEQ_JMA_CODES ? "<p>区域・震央地名の値: 気象庁『地震火山関連コード表』（https://xml.kishou.go.jp/tec_material.html）を FlEq が加工して作成</p>" : ""}
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

// 「作る」: /generate で作り、返った報を retime=0 で第 1 報はすぐ、以後 4 秒おきに /inject へ送る。
const SRC = ["place", "lat", "lon", "depthKm", "magnitude"];
const FIELDS = { VXSE43: [...SRC, "maxInt", "area", "serial", "reports", "end"], VXSE45: [...SRC, "maxInt", "area", "serial", "reports", "end"],
  VXSE51: ["maxInt", "area"], VXSE52: SRC, VXSE53: [...SRC, "maxInt", "area", "serial"], VTSE41: SRC, VTSE51: [...SRC, "serial"], VTSE52: [...SRC, "serial"] };
// 場面は流れだけを持ち、地域と震央は欄の今の値を使う（D-SCENE-AREA）。資料が無いときの欄の初期値は公開サンプルの値。
const DEFAULT = { eew: { area: "622", place: "681", lat: "33.2", lon: "132.4" }, quake: { area: "442", place: "485", lat: "34.8", lon: "138.5" }, tsunami: { area: "", place: "288", lat: "38.0", lon: "142.9" } };
let turn = 0; // 操作を始めるたびに進める世代の番号
const FIVE_MINUS = { magnitude: "5.5", depthKm: "50", maxInt: "5-" };
const SCENES = { eew3: [{ family: "VXSE45", reports: "3", end: "final", ...FIVE_MINUS }], eew2: [{ family: "VXSE43", reports: "2", end: "final", ...FIVE_MINUS }],
  eewCancel: [{ family: "VXSE45", reports: "1", end: "cancel", ...FIVE_MINUS }], quake: [{ family: "VXSE51", ...FIVE_MINUS }, { family: "VXSE53", ...FIVE_MINUS }],
  tsunami: [{ family: "VTSE41", magnitude: "7.5", depthKm: "10" }] };
const KEY = "fleq-watch-region";
const group = (family) => family.startsWith("VTSE") ? "tsunami" : family === "VXSE43" || family === "VXSE45" ? "eew" : "quake";
// 覚える値は分野の組（EEW・地震情報・津波）ごとに分ける。今の分野の選択肢に無い値は使わず、その組の初期値にする。
const mem = { eew: {}, quake: {}, tsunami: {} };
const regionOf = (k) => {
  const family = $("family").value, g = group(family), sel = $(k + "-" + family);
  const usable = (value) => value != null && (sel == null || [...sel.options].some((o) => o.value === value));
  // 区域・震央地名は今の組に値が無ければ、ほかの組に覚えた値のうち今の分野の select にあるものを初期値より先に使う（一度選べば次からも同じ地域）。
  const remembered = k === "area" || k === "place" ? [g, ...Object.keys(mem).filter((other) => other !== g)] : [g];
  const found = remembered.map((name) => mem[name][k]).find(usable);
  return found ?? DEFAULT[g][k];
};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) {} };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  for (const g of Object.keys(mem)) for (const k of ["area", "place", "lat", "lon"]) {
    const value = saved[g]?.[k];
    if (typeof value === "string" && (k === "area" || k === "place" || Number.isFinite(Number(value)))) mem[g][k] = value;
  }
} catch (e) {}
function refresh() {
  const family = $("family").value;
  const fields = $("cancel").checked ? (FIELDS[family].includes("serial") ? ["serial"] : []) : FIELDS[family];
  for (const label of document.querySelectorAll("label[data-field]")) label.hidden = !fields.includes(label.dataset.field);
  for (const sel of document.querySelectorAll("select[data-kind]")) {
    sel.hidden = sel.dataset.family !== family;
    if (!sel.hidden) sel.value = regionOf(sel.dataset.kind);
  }
  $("lat").value = regionOf("lat");
  $("lon").value = regionOf("lon");
}
for (const sel of document.querySelectorAll("select[data-kind]")) sel.onchange = () => { mem[group(sel.dataset.family)][sel.dataset.kind] = sel.value; save(); };
for (const k of ["lat", "lon"]) $(k).onchange = () => { mem[group($("family").value)][k] = $(k).value.trim(); save(); };
$("family").onchange = refresh;
$("cancel").onchange = refresh;

const collect = () => {
  const family = $("family").value;
  const out = { family };
  const put = (k, v) => { if (v !== "") out[k] = v; };
  put("originTime", $("originTime").value.trim());
  const numeric = (k) => { const v = $(k).value.trim(); return v === "" ? "" : Number(v); };
  if ($("cancel").checked) {
    if (FIELDS[family].includes("serial")) put("serial", numeric("serial"));
    out.cancel = true;
    return out;
  }
  for (const k of FIELDS[family]) {
    if (k === "place" || k === "area") put(k + "Code", regionOf(k));
    else if (k === "maxInt" || k === "end") put(k, $(k).value);
    else put(k, numeric(k));
  }
  return out;
};
async function generate(mine) {
  const r = await fetch("/generate", { method: "POST", body: JSON.stringify(collect()) });
  const j = await r.json();
  if (mine !== turn) return null; // 古い操作の応答は捨てる（新しい場面の再生や起点の欄を奪わせない）
  if (!r.ok) { $("made").textContent = "拒否（" + j.error + (j.field ? "：" + j.field : "") + "）"; return null; }
  $("originTime").value = j.originTime; // Serial を進めて作り直しても同じ地震になる
  return j;
}
async function play(items, mine) {
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await new Promise((wake) => setTimeout(wake, 4000));
    if (mine !== turn) return;
    $("made").textContent = "送信 " + (i + 1) + "/" + items.length;
    const r = await fetch("/inject?type=" + items[i].type + "&retime=0", { method: "POST", body: items[i].xml });
    const j = await r.json();
    if (mine !== turn) return;
    if (!j.sent) { $("made").textContent = "送れなかった（" + j.error + "）"; return; }
  }
  if (mine === turn) $("made").textContent = "送った " + items.length + " 報";
}
const queue = (j) => j.reports.map((report) => ({ type: j.headType, xml: report.xml }));
$("make").onsubmit = async (e) => {
  e.preventDefault();
  const mine = ++turn;
  $("made").textContent = "作成中";
  try { const j = await generate(mine); if (j) await play(queue(j), mine); } catch (err) { if (mine === turn) $("made").textContent = "失敗（" + err + "）"; }
};
for (const button of document.querySelectorAll("button[data-scene]")) button.onclick = async () => {
  const mine = ++turn;
  $("made").textContent = "作成中";
  try {
    const items = [];
    $("cancel").checked = false;
    $("originTime").value = "";
    for (const step of SCENES[button.dataset.scene]) {
      $("family").value = step.family;
      refresh();
      for (const k of ["magnitude", "depthKm", "maxInt", "reports", "end", "serial"]) if ($(k)) $(k).value = step[k] ?? (k === "end" ? "none" : k === "maxInt" ? "5-" : "");
      const j = await generate(mine);
      if (!j) return;
      items.push(...queue(j));
    }
    await play(items, mine);
  } catch (err) { if (mine === turn) $("made").textContent = "失敗（" + err + "）"; }
};
$("family").value = "VXSE45";
refresh();
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

  // FLEQ_JMA_CODES の誤りを最初の「作る」まで隠さない（P3-RW2-AC12 (3)）。子を起こす前に読む。
  try { choices("VXSE53"); } catch (error) { fail({ error: "codesUnreadable", message: String(error?.message ?? error) }); return 1; }

  let port = 0;
  let current = null; // 今 frame を送る接続
  let socketId = 0;
  let pingId = 0;
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  // 本文を limit まで集めて done に渡す。超えたら 413（/inject は 8 MiB、/generate は 64 KiB）。
  const collect = (req, res, limit, done) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > limit) { tooLarge = true; chunks.length = 0; json(res, 413, { error: "bodyTooLarge" }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) done(Buffer.concat(chunks)); });
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
    if (url.pathname === "/generate") {
      if (req.method !== "POST") return json(res, 405, { error: "methodNotAllowed" });
      return collect(req, res, GENERATE_LIMIT, (body) => {
        let input;
        try { input = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "badRequest" }); }
        let made;
        try { made = generateTelegrams(input); } catch { return json(res, 500, { error: "generateFailed" }); } // 1 件の失敗で常駐を落とさない
        if (made.kind === "rejected") return json(res, 400, { error: made.reason, field: made.field });
        json(res, 200, { headType: made.headType, eventId: made.eventId, originTime: made.originTime, reports: made.reports });
      });
    }
    if (url.pathname !== "/inject") return json(res, 404, { error: "notFound" });
    if (req.method !== "POST") return json(res, 405, { error: "methodNotAllowed" });
    const type = url.searchParams.get("type");
    if (type == null) return json(res, 400, { error: "typeRequired" });
    if (!TYPE_EXACT.test(type)) return json(res, 400, { error: "typeInvalid" });
    const retimeParam = url.searchParams.get("retime");
    if (retimeParam != null && retimeParam !== "0" && retimeParam !== "1") return json(res, 400, { error: "retimeInvalid" });
    collect(req, res, BODY_LIMIT, (body) => {
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
