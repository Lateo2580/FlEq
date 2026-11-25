// P4-DS-T10 実 Chrome の smoke（P4-DS-AC03・AC04・AC06・AC09・AC11・AC12・AC13）。node reconstruction/test/screen/smoke.mjs
// 統合担当が開発機で走らせる（子の sandbox は listen できない）。先に tsc の 4 本（reconstruction/dist と dist/screen を作る）が要る。
// S0 は登録が 0 本でカードが出ないので、dist/screen の module を一時の dir へ写し、試験用のカードの登録（cards.js）と、
// 押した点・ページの番号・描き直しの入口を読む 3 行だけを差し替える（製品の module は変えない）。
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

// ---- 試験用の module の dir（dist/screen の写し。差し替えは cards.js と main.js の 3 行）----
const modules = join(work, "modules");
cpSync(join(repo, "reconstruction/dist/screen/src/display/screen"), modules, { recursive: true });
writeFileSync(join(modules, "cards.js"), `
const row = (height, text, token) => ({ height, token: null, texts: [{ text, token }], continuation: [] });
const head = (text) => ({ height: 90, token: null, texts: [{ text, token: "ink" }], continuation: [] });
// 本文の字と slot のカードの数は snapshot の欄から取る（同じ構造・同じ件数で字だけを替える、AC09 (2)）
const source = (snapshot) => [
  { id: "t1", column: "right", place: 0, take: 0, slot: null, mayHide: false, opened: null,
    forms: [{ head: [head("見出し")], body: (snapshot.smokeTexts ?? []).map((text, i) => row(100, text, i % 2 === 0 ? "ink" : "bogus-token")), maxPages: null, minBodyRows: 1 }] },
  ...Array.from({ length: snapshot.smokeSlots ?? 0 }, (_, i) => ({ id: "e" + i, column: "right", place: 0, take: 0, slot: i, mayHide: false, opened: null,
    forms: [{ head: [head("緊急 " + i)], body: [], maxPages: null, minBodyRows: 0 }] })),
];
const CARD_SOURCES = [{ source, max: 10 }];
export { CARD_SOURCES };
`);
const mainPath = join(modules, "main.js");
let main = readFileSync(mainPath, "utf8");
const patch = (pattern, replacement) => {
  if (!pattern.test(main)) throw new Error(`main.js に ${pattern} が無い（smoke の差し替え）`);
  main = main.replace(pattern, replacement);
};
patch(/reduceShell\(shell, \{ kind: "press", frame, x: event\.clientX \/ scale, y: event\.clientY \/ scale \}\)/, (call) => `(window.__press = { x: event.clientX / scale, y: event.clientY / scale }, ${call})`);
patch(/const page = \{ left: 0, right: 0 \};/, "const page = window.__page = { left: 0, right: 0 };");
patch(/const MARK_KEEP = 64;/, "const MARK_KEEP = 2;"); // 追い出しを少ない版で起こす
patch(/\nboot\(\);/, "\nwindow.__requestFrame = requestFrame;\nboot();");
writeFileSync(mainPath, main);

// ---- snapshot（外形だけの v3。client が確かめるのは外形で、カードは試験用の登録が smokeTexts・smokeSlots から作る）----
const UNITS = { eew: "U-E", tsunami: "U-T", earthquake: "U-Q", weatherCurrent: "U-W", weatherTimeseries: "U-F", nankai: "U-N",
  volcano: "U-V", landslide: "U-L", flood: "U-R", briefing: "U-B", localBulletins: "U-M", typhoon: "U-Y" };
const snapshot = (sequence, texts, slots = 0, streamId = "smoke") => ({ schemaVersion: "p4-display-wire-v3", streamId, sequence, semanticRevision: `s${sequence}`,
  current: Object.fromEntries(Object.entries(UNITS).map(([key, unit]) => [key, { unit, contentRevision: `r${sequence}` }])), notices: [], smokeTexts: texts, smokeSlots: slots });
const plain = (tag = "") => Array.from({ length: 30 }, (_, i) => `行${tag} ${i + 1}`);
const WORKER = { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null };
const serve = (port) => startDisplayServer({ host: "127.0.0.1", port, worker: WORKER,
  wireAssets: { htmlPath: join(repo, "reconstruction/src/display/screen/index.html"), moduleDirectory: modules } });

// ---- Chrome（CDP）。途中で throw しても必ず kill し、exit を待ってから一時 dir を消す ----
const profile = join(work, "profile");
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--headless=new", "--force-color-profile=srgb", "--disable-background-timer-throttling", "about:blank"], { stdio: "ignore" });
const exited = new Promise((done) => chrome.once("exit", done));
let socket = null, server = null;

async function run() {
  for (let i = 0; i < 100 && socket == null; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page != null) socket = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* 起動待ち */ }
    if (socket == null) await sleep(100);
  }
  if (socket == null) throw new Error("chrome did not start");
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
  // smoke 自身が layout を読む式は、画面の側の呼びの数に入れない
  const probe = (expression) => evaluate(`(() => { window.__quiet = true; try { return (${expression}); } finally { window.__quiet = false; } })()`);
  const until = async (expression, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await evaluate(expression)) return true; await sleep(50); } return false; };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };

  // listener・timer・EventSource の生きている数と、layout を読む API の呼びの数を数える包み（document の開始前に入れる）
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
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
    const count = () => { if (!window.__quiet) layoutCalls++; };
    for (const name of ["getBoundingClientRect", "getClientRects"]) { const original = Element.prototype[name]; Element.prototype[name] = function (...a) { count(); return original.apply(this, a); }; }
    for (const name of ["offsetTop", "offsetLeft", "offsetWidth", "offsetHeight", "offsetParent", "clientTop", "clientLeft", "clientWidth", "clientHeight", "scrollTop", "scrollLeft", "scrollWidth", "scrollHeight"]) {
      for (const proto of [HTMLElement.prototype, Element.prototype]) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor?.get != null) { Object.defineProperty(proto, name, { ...descriptor, get() { count(); return descriptor.get.call(this); } }); break; }
      }
    }
    const computed = window.getComputedStyle;
    window.getComputedStyle = (...a) => { count(); return computed.apply(window, a); };
    window.__count = () => ({ listeners: [...live.values()].reduce((n, m) => n + [...m.values()].reduce((k, s) => k + s.size, 0), 0), timers: timers.size, frames: frames.size, sources: sources.size, layoutCalls });
    window.__resetLayout = () => { layoutCalls = 0; };
  })();` });

  server = await serve(0);
  const serverPort = server.port;
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/display` });
  await until(`document.getElementById("clock-time")?.textContent !== undefined`);

  // (e) 名前つきの snapshot の 1 通が画面に出る。2 ページ以上の列でページの表示の字と点、時計の位置が tokens.ts の値、カードの面の色はカード自身で
  server.publishWire(snapshot(1, plain()), true);
  check("T10-e1 snapshot が画面に出る", await until(`document.querySelectorAll(".card").length === 1`), "名前つき event: snapshot");
  check("T10-e2 ページの表示の字と点", await evaluate(`/^1\\/\\d+$/.test(document.querySelector(".mark.last span")?.textContent ?? "") && document.querySelectorAll(".mark.last .dot").length >= 2`), "mark");
  check("T10-e3 時計の位置", await probe(`(() => { const c = document.getElementById("clock"); return c.style.left === "40px" && c.style.top === "960px"; })()`), "clock (40,960)");
  check("T10-e3 カードの面の色（カード自身）", await probe(`getComputedStyle(document.querySelector(".card")).backgroundColor === "rgb(20, 23, 35)"`), "surface #141723");
  check("T10-e4 token の class は表にあるものだけ", await evaluate(`document.querySelectorAll(".card .t-ink").length > 0 && !document.querySelector(".card [class*=bogus]")`), "TOKEN_CLASS");

  // (a) 字の差し替え: 同じ構造・同じ件数のまま字だけを HTML や改行を含む値にし、4 種とも字面を照らす
  const before = await evaluate(`document.querySelectorAll(".card *").length`);
  const hostile = Array.from({ length: 30 }, (_, i) => [`<img src=x onerror="window.__x=1">`, `<script>window.__x=2</script>`, `&lt;b&gt;`, `改\n行`][i % 4]);
  server.publishWire(snapshot(2, hostile), true);
  await until(`document.querySelector(".card .row:nth-child(2) span")?.textContent === ${JSON.stringify(hostile[0])}`);
  check("T10-a 要素の数が変わらない", (await evaluate(`document.querySelectorAll(".card *").length`)) === before, "count");
  check("T10-a 実行される要素が 0", await evaluate(`typeof window.__x === "undefined" && document.querySelectorAll(".card img, .card script").length === 0`), "no exec");
  for (let i = 0; i < 4; i++) check(`T10-a 字面が一致（${i + 1}/4）`, await evaluate(`document.querySelector(".card .row:nth-child(${i + 2}) span").textContent === ${JSON.stringify(hostile[i])}`), "textContent");

  // (b)(c) 再接続とページの切替を繰り返した後の数が最初と同じ。更新と時計で layout を読む API の呼びが 0
  const baseline = await evaluate(`window.__count()`);
  await evaluate(`window.__resetLayout()`);
  for (let round = 0; round < 5; round++) {
    await server.close();
    server = await serve(serverPort);
    // 3 回目（round 2）は新しい streamId で sequence 1（host の起動し直しと同じ形）。以降はその stream で続ける
    const fresh = round === 2;
    server.publishWire(snapshot(fresh ? 1 : 10 + round, plain(`#${round}`), 0, round >= 2 ? "smoke2" : "smoke"), true);
    // EventSource の自動の再接続（既定の待ちは約 3 秒）の後、この回に固有の版が画面に届く
    check(`T10-b 再接続 ${round + 1} 回目の版が画面に届く`, await until(`document.querySelector(".card .row:nth-child(2) span")?.textContent === "行#${round} 1"`, 15000), fresh ? "新しい stream・sequence 1" : `版 ${10 + round}`);
  }
  for (let i = 0; i < 20; i++) {
    const to = i % 3;
    await evaluate(`window.__page.right = ${to}; window.__requestFrame()`);
    if (!(await until(`document.querySelector(".mark.last span")?.textContent?.startsWith("${to + 1}/")`, 3000))) check(`T10-b ページ ${to + 1} へ切り替わる`, false, `i=${i}`);
  }
  await evaluate(`window.__page.right = 0; window.__requestFrame()`);
  await sleep(200);
  const after = await evaluate(`window.__count()`);
  check("T10-b 再接続 5 回とページの切替 20 回の後の数が同じ", ["listeners", "timers", "sources"].every((name) => after[name] === baseline[name]), JSON.stringify({ baseline, after }));
  // (c) 分の変わり目を 1 回起こして、時計の字が変わること
  const clockBefore = await evaluate(`document.getElementById("clock-time").textContent`);
  check("T10-c 分の変わり目で時計の字が変わる", await until(`document.getElementById("clock-time").textContent !== ${JSON.stringify(clockBefore)}`, 65000), clockBefore);
  const finalCount = await evaluate(`window.__count()`);
  check("T10-c layout を読む API の呼びが 0", finalCount.layoutCalls === 0, `layoutCalls=${finalCount.layoutCalls}`);

  // (d) E04 の 2 つの mark の差（記録だけ、合否にしない）
  const marks = await evaluate(`performance.getEntriesByType("mark").map((m) => [m.name, m.startTime])`);
  const late = marks.filter(([name]) => name.startsWith("fleq:s0:painted:")).at(-1);
  const got = late == null ? null : marks.find(([name]) => name === late[0].replace("painted", "received"));
  results.push({ id: "T10-d E04 received→painted", status: "Record", detail: late == null || got == null ? "mark なし" : `${Math.round((late[1] - got[1]) * 10) / 10} ms (${late[0]})` });

  // 印の名前は streamId と sequence の両方。古い stream の追い出しが、新しい stream の同じ sequence の印を消さない（MARK_KEEP を 2 に差し替えてある）
  const markCount = (kind, version) => evaluate(`performance.getEntriesByName("fleq:s0:${kind}:${version}", "mark").length`);
  for (const [stream, sequence] of [["sa", 1], ["sa", 2], ["sb", 1]]) {
    server.publishWire(snapshot(sequence, ["一"], 0, stream), true);
    await until(`performance.getEntriesByName("fleq:s0:painted:${stream}:${sequence}", "mark").length === 1`, 5000);
  }
  check("T10-b2 追い出された版の印は消える", (await markCount("painted", "sa:1")) === 0 && (await markCount("received", "sa:1")) === 0, "sa:1");
  check("T10-b2 新しい stream の sequence 1 の印が残る", (await markCount("received", "sb:1")) === 1 && (await markCount("painted", "sb:1")) === 1, "sb:1");

  // C5: 伸ばさないカードで、1 行目の上端＝カードの上端、最後の行の下端＝カードの下端。時計の字の大きさと上の内側
  server.publishWire(snapshot(30, ["一", "二"]), true);
  await until(`document.querySelectorAll(".card .row").length === 3`);
  check("T10-c5 行がカードをはみ出さず隙間も無い", await probe(`(() => { const c = document.querySelector(".card").getBoundingClientRect(), rows = [...document.querySelectorAll(".card .row")].map((r) => r.getBoundingClientRect());
    return Math.abs(rows[0].top - c.top) < 0.5 && Math.abs(rows.at(-1).bottom - c.bottom) < 0.5; })()`), "row top/bottom = card");
  check("T10-c5 時計の字の大きさと上の内側", await probe(`(() => { const s = (id) => getComputedStyle(document.getElementById(id)); return s("clock-date").fontSize === "30px" && s("clock-time").fontSize === "56px" && s("clock").paddingTop === "6px"; })()`), "30/56/6");

  // C1: 中間の層のカードは cover の中に描かない。slot のカード 3 枚（右の列）と右の列のカード 1 枚。間 362〜379 の点は地図で、押しても状態が変わらない
  server.publishWire(snapshot(40, ["一", "二", "三", "四", "五"], 3), true); // 高さ 590（40〜630）で間 362〜379 にかかる
  await until(`document.querySelectorAll("#cards-top .card").length === 3`);
  check("T10-c1 間の点は中間の層のカードでなく地図", await evaluate(`!document.elementsFromPoint(1500, 370).some((node) => node.closest(".card"))`), "elementsFromPoint (1500, 370)");
  check("T10-c1 カードの面の点にはカードがある", await evaluate(`!!document.elementFromPoint(1500, 200)?.closest("#cards-top .card")`), "elementFromPoint (1500, 200)");
  await click(1500, 370);
  await sleep(200);
  check("T10-c1 間を押しても状態が変わらない", await evaluate(`document.querySelectorAll("#cards-top .card").length === 3 && document.querySelectorAll("#cards-middle .card.dim").length === 1`), "top 3");
  await click(1260, 300);
  // 製品に属性を足さず、カードは見出しの字で見分ける（試験用の登録の右の列のカードは「見出し」、緊急は「緊急 N」）
  const parentOf = (text) => `[...document.querySelectorAll(".card")].find((c) => c.textContent.startsWith(${JSON.stringify(text)}))?.parentElement.id`;
  check("T10-c1 ずれて出た所を押すと上がる", await until(`document.querySelectorAll("#cards-top .card").length !== 3`, 3000), "raised");
  check("T10-c1 上げたカードの親は最上層", (await evaluate(parentOf("見出し"))) === "cards-top", "#cards-top");
  check("T10-c1 下がった緊急地震速報のカードの親は中間の層", (await evaluate(parentOf("緊急 0"))) === "cards-middle", "#cards-middle");
  await click(1830, 100);
  check("T10-c1 下がったカードを押すと戻る", await until(`(${parentOf("見出し")}) === "cards-middle" && (${parentOf("緊急 0")}) === "cards-top"`, 3000), "戻した後の親");
  check("T10-c1 戻した後に間の点がまた地図になる", await evaluate(`!document.elementsFromPoint(1500, 370).some((node) => node.closest(".card"))`), "elementsFromPoint (1500, 370)");

  // (f) viewport 1920×1080 で時計 (40,960)、960×540 で全体 0.5 倍・時計 (20,480)、押した点が 1920×1080 の座標に戻る
  server.publishWire(snapshot(50, ["一"]), true);
  const clockAt = `(() => { const r = document.getElementById("clock").getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`;
  check("T10-f 1920×1080 で時計 (40, 960)", JSON.stringify(await probe(clockAt)) === "[40,960]", "clock");
  await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  check("T10-f 960×540 で時計 (20, 480)", JSON.stringify(await probe(clockAt)) === "[20,480]", "clock 0.5");
  await click(480, 270);
  await sleep(100);
  const press = await evaluate(`window.__press ?? null`);
  check("T10-f 押した点が 1920×1080 の座標へ戻る", press != null && Math.abs(press.x - 960) < 1 && Math.abs(press.y - 540) < 1, JSON.stringify(press));
}

try {
  await run();
} catch (error) {
  results.push({ id: "smoke の実行", status: "Fail", detail: String(error?.stack ?? error) });
} finally {
  socket?.close();
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  await server?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((item) => item.status === "Fail") ? 1 : 0);
