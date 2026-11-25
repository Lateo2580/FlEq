// P4-DS-T10 実 Chrome の smoke（P4-DS-AC03・AC04・AC09・AC11・AC12）。node reconstruction/test/screen/smoke.mjs
// 統合担当が開発機で走らせる（子の sandbox は listen できない）。先に tsc の 4 本（reconstruction/dist と dist/screen を作る）が要る。
// S0 は登録が 0 本でカードが出ないので、dist/screen の module を一時の dir へ写し、試験用のカードの登録（cards.js）と、押した点を読む 1 行だけを差し替える。
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { startDisplayServer } from "../../dist/src/http-sse/http-sse.js";

const repo = join(import.meta.dirname, "../../..");
const CHROME = process.env.FLEQ_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const work = mkdtempSync(join(tmpdir(), "fleq-s0-smoke-"));
const results = [];
const check = (id, ok, detail) => { results.push({ id, status: ok ? "Pass" : "Fail", detail }); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- 試験用の module の dir（dist/screen の写し。差し替えは 2 か所だけ）----
const modules = join(work, "modules");
cpSync(join(repo, "reconstruction/dist/screen/src/display/screen"), modules, { recursive: true });
writeFileSync(join(modules, "cards.js"), `
const row = (height, text, token) => ({ height, texts: [{ text, token }], continuation: [] });
// 本文の字は snapshot の欄から取る（同じ構造・同じ件数で字だけを替える、AC09 (2)）
const source = (snapshot) => [{ id: "t1", column: "right", place: 0, take: 0, slot: null, mayHide: false, opened: null,
  forms: [{ head: [row(90, "見出し", "ink")], body: (snapshot.smokeTexts ?? []).map((text, i) => row(100, text, i % 2 === 0 ? "ink" : "bogus-token")), maxPages: null, minBodyRows: 1 }] }];
const CARD_SOURCES = [{ source, max: 1 }];
export { CARD_SOURCES };
`);
const mainPath = join(modules, "main.js");
const main = readFileSync(mainPath, "utf8");
const pressCall = /reduceShell\(shell, \{ kind: "press", frame, x: event\.clientX \/ scale, y: event\.clientY \/ scale \}\)/;
if (!pressCall.test(main)) throw new Error("press call not found in main.js (smoke patch)");
writeFileSync(mainPath, main.replace(pressCall, (call) => `(window.__press = { x: event.clientX / scale, y: event.clientY / scale }, ${call})`));

// ---- snapshot（外形だけの v3。client が確かめるのは外形で、カードは試験用の登録が smokeTexts から作る）----
const UNITS = { eew: "U-E", tsunami: "U-T", earthquake: "U-Q", weatherCurrent: "U-W", weatherTimeseries: "U-F", nankai: "U-N",
  volcano: "U-V", landslide: "U-L", flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };
const snapshot = (sequence, texts) => ({ schemaVersion: "p4-display-wire-v3", streamId: "smoke", sequence, semanticRevision: `s${sequence}`,
  current: Object.fromEntries(Object.entries(UNITS).map(([key, unit]) => [key, { unit, contentRevision: `r${sequence}` }])), notices: [], smokeTexts: texts });
const plain = Array.from({ length: 30 }, (_, i) => `行 ${i + 1}`);

// ---- Chrome（CDP）----
const profile = join(work, "profile");
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--headless=new", "--force-color-profile=srgb", "--disable-background-timer-throttling", "about:blank"], { stdio: "ignore" });
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page != null) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* 起動待ち */ }
    await sleep(100);
  }
  throw new Error("chrome did not start");
}
const socket = await connect();
await new Promise((done) => socket.once("open", done));
let nextId = 0;
const waiting = new Map();
socket.on("message", (raw) => { const message = JSON.parse(raw.toString()); waiting.get(message.id)?.(message); });
const send = (method, params = {}) => new Promise((done, fail) => {
  const id = ++nextId;
  waiting.set(id, (message) => { waiting.delete(id); if (message.error != null) fail(new Error(message.error.message)); else done(message.result); });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
const until = async (expression, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression)) return true; await sleep(50); } return false; };

// listener・timer・EventSource の生きている数と、layout を読む API の呼びの数を数える包み（document の開始前に入れる）
await send("Page.enable");
await send("Page.addScriptToNewDocument", { source: `(() => {
  const live = new Map(), timers = new Set(), frames = new Set(), sources = new Set(); let layoutCalls = 0;
  const key = (target, type, handler) => { if (!live.has(target)) live.set(target, new Map()); const map = live.get(target); if (!map.has(type)) map.set(type, new Set()); map.get(type).add(handler); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, ...rest) { key(this, type, handler); return add.call(this, type, handler, ...rest); };
  EventTarget.prototype.removeEventListener = function (type, handler, ...rest) { live.get(this)?.get(type)?.delete(handler); return remove.call(this, type, handler, ...rest); };
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = (fn, ms, ...a) => { const id = st(() => { timers.delete(id); fn(...a); }, ms); timers.add(id); return id; };
  window.clearTimeout = (id) => { timers.delete(id); ct(id); };
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (fn) => { const id = raf((t) => { frames.delete(id); fn(t); }); frames.add(id); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); caf(id); };
  const ES = window.EventSource;
  window.EventSource = class extends ES { constructor(...a) { super(...a); sources.add(this); } close() { sources.delete(this); super.close(); } };
  for (const name of ["getBoundingClientRect", "getClientRects"]) { const original = Element.prototype[name]; Element.prototype[name] = function (...a) { layoutCalls++; return original.apply(this, a); }; }
  window.__count = () => ({ listeners: [...live.values()].reduce((n, m) => n + [...m.values()].reduce((k, s) => k + s.size, 0), 0), timers: timers.size, frames: frames.size, sources: sources.size, layoutCalls });
  window.__resetLayout = () => { layoutCalls = 0; };
})();` });

// ---- server ----
let server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
  wireAssets: { htmlPath: join(repo, "reconstruction/src/display/screen/index.html"), moduleDirectory: modules } });
const serverPort = server.port;
const url = `http://127.0.0.1:${serverPort}/display`;
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(500);

try {
  // (e) 名前つきの snapshot の 1 通が画面に出る。2 ページ以上の列でページの表示の字と点、時計の位置と面の色が tokens.ts の値
  server.publishWire(snapshot(1, plain), true);
  check("T10-e1 snapshot が画面に出る", await until(`document.querySelectorAll("#cards .card").length === 1`), "名前つき event: snapshot");
  check("T10-e2 ページの表示の字と点", await evaluate(`/^1\\/\\d+$/.test(document.querySelector(".mark.last span")?.textContent ?? "") && document.querySelectorAll(".mark.last .dot").length >= 2`), "mark");
  check("T10-e3 時計の位置と面の色", await evaluate(`(() => { const c = document.getElementById("clock"); const s = getComputedStyle(c);
    return c.style.left === "40px" && c.style.top === "960px" && s.backgroundColor === "rgb(20, 23, 35)"; })()`), "clock (40,960) surface #141723");
  check("T10-e4 token の class は表にあるものだけ", await evaluate(`document.querySelectorAll("#cards .t-ink").length > 0 && !document.querySelector("#cards [class*=bogus]")`), "TOKEN_CLASS");

  // (a) 字の差し替え: 同じ構造・同じ件数のまま字だけを HTML や改行を含む値にする
  const before = await evaluate(`document.querySelectorAll("#cards *").length`);
  const hostile = plain.map((_, i) => [`<img src=x onerror="window.__x=1">`, `<script>window.__x=2</script>`, `&lt;b&gt;`, `改\n行`][i % 4]);
  server.publishWire(snapshot(2, hostile), true);
  await until(`document.querySelector("#cards .row:nth-child(2) span")?.textContent === ${JSON.stringify(hostile[0])}`);
  check("T10-a 要素の数が変わらない", (await evaluate(`document.querySelectorAll("#cards *").length`)) === before, "count");
  check("T10-a 実行される要素が 0", (await evaluate(`typeof window.__x === "undefined" && document.querySelectorAll("#cards img, #cards script").length === 0`)), "no exec");
  check("T10-a 字面が一致", await evaluate(`document.querySelector("#cards .row:nth-child(2) span").textContent === ${JSON.stringify(hostile[0])}`), "textContent");

  // (b)(c) 再接続とページの切替を繰り返した後の数が最初と同じ。更新と時計で layout を読む API の呼びが 0
  const baseline = await evaluate(`window.__count()`);
  await evaluate(`window.__resetLayout()`);
  for (let round = 0; round < 5; round++) {
    await server.close();
    server = await startDisplayServer({ host: "127.0.0.1", port: serverPort, worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
      wireAssets: { htmlPath: join(repo, "reconstruction/src/display/screen/index.html"), moduleDirectory: modules } });
    server.publishWire(snapshot(10 + round, plain), true);
    await sleep(3500); // EventSource の自動の再接続（既定の待ちは約 3 秒）
  }
  for (let i = 0; i < 20; i++) { await evaluate(`window.fleqScreenSetPage("right", ${i % 3})`); await sleep(30); }
  await sleep(200);
  const after = await evaluate(`window.__count()`);
  check("T10-b 再接続 5 回とページの切替 20 回の後の数が同じ", ["listeners", "timers", "sources"].every((name) => after[name] === baseline[name]), JSON.stringify({ baseline, after }));
  check("T10-c layout を読む API の呼びが 0", after.layoutCalls === 0, `layoutCalls=${after.layoutCalls}`);

  // (d) E04 の 2 つの mark の差（記録だけ、合否にしない）
  const marks = await evaluate(`performance.getEntriesByType("mark").map((m) => [m.name, m.startTime])`);
  const late = marks.filter(([name]) => name.startsWith("fleq:s0:painted:")).at(-1);
  const got = late == null ? null : marks.find(([name]) => name === late[0].replace("painted", "received"));
  results.push({ id: "T10-d E04 received→painted", status: "Record", detail: late == null || got == null ? "mark なし" : `${Math.round((late[1] - got[1]) * 10) / 10} ms (${late[0]})` });

  // (f) viewport 1920×1080 で時計 (40,960)、960×540 で全体 0.5 倍・時計 (20,480)、押した点が 1920×1080 の座標へ戻る
  const clockAt = `(() => { const r = document.getElementById("clock").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`;
  check("T10-f 1920×1080 で時計 (40, 960)", JSON.stringify(await evaluate(clockAt)) === "[40,960]", "clock");
  await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  check("T10-f 960×540 で時計 (20, 480)", JSON.stringify(await evaluate(clockAt)) === "[20,480]", "clock 0.5");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 480, y: 270, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 480, y: 270, button: "left", clickCount: 1 });
  await sleep(100);
  const press = await evaluate(`window.__press ?? null`);
  check("T10-f 押した点が 1920×1080 の座標へ戻る", press != null && Math.abs(press.x - 960) < 1 && Math.abs(press.y - 540) < 1, JSON.stringify(press));
} finally {
  socket.close();
  chrome.kill();
  await server.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((item) => item.status === "Fail") ? 1 : 0);
