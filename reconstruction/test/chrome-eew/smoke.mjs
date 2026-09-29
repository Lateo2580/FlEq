// P2-CHROME-EEW-001 requiredCommands: A8 startDisplayServerの固定URL配信から前景実Chromeで単発EventSource・
// card/map paint・固定名marker・CDP clock probe・stale再接続の証拠を取る。
// 実paintはPage.captureScreenshotの画素で判定し、DOM存在・rAF・unit testだけでPassにしない。
// snapshotはA1/A8の実経路 (fixture→reduceRuntime→projectSnapshot) で作り、射影で作れない状態だけを型どおりに組む。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { decodeMaterial } from "../../dist/src/decode-material/decode-material.js";
import { startDisplayServer } from "../../dist/src/http-sse/http-sse.js";
import { ingestXmlData } from "../../dist/src/ingress/ingress.js";
import { linkedRuntimeCalls, linkedUnitCodecs, snapshotInput } from "../../dist/src/runtime/composition-root.js";
import { reduceRuntime } from "../../dist/src/runtime/shared-runtime.js";
import { projectSnapshot } from "../../dist/src/view-projector/view-projector.js";

const repo = join(import.meta.dirname, "../../..");
const evidenceDir = join(import.meta.dirname, "evidence");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 前景tabのまま45秒の実時間待ちを保つためのthrottling停止と、画素を解決済みtokenの実値と比べるためのsRGB固定。
const CHROME_FLAGS = ["--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  "--force-color-profile=srgb", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows"];
const STALE_BANNER = "更新未確認の最終情報";
const T5 = "fleq:p2:eew:T5";
const T6 = "fleq:p2:eew:T6-candidate";

const contract = JSON.parse(readFileSync(join(repo, "reconstruction/contracts/p2-chrome-eew.json"), "utf8"));
const conditions = JSON.parse(readFileSync(join(repo, "reconstruction/test/eew-e01/evidence/chrome-smoke-conditions.json"), "utf8"));
const paint = Object.fromEntries(contract.meta.questionResolutions.find((q) => q.id === "P2-A9-GEOMETRY")
  .paintExpectations.map((item) => [item.fixtureId.endsWith("VXSE43") ? "VXSE43" : "VXSE45", item]));
const contractGeometrySha = /sha256=([0-9a-f]{64})/.exec(
  contract.contract.acceptanceChecks.find((check) => check.id === "P2-A9-AC03").requirement)[1];

// 期待色はtheme.cssのtokenを実値まで解決して作る (index.htmlの写しがずれたら画素で落ちる)。
const themeCss = readFileSync(join(repo, "display/frontend/src/lib/theme.css"), "utf8");
const rootStart = themeCss.indexOf(":root {");
const themeRoot = themeCss.slice(rootStart, themeCss.indexOf("\n}", rootStart));
const themeRaw = new Map([...themeRoot.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
function token(name) {
  const value = themeRaw.get(name);
  const ref = /^var\((--[\w-]+)\)$/.exec(value ?? "");
  if (ref != null) return token(ref[1]);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value ?? "")?.[1];
  if (hex == null) throw new Error(`theme token ${name} is not a color: ${value}`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}
const SEVERITY_TOKEN = { "1": "--int-1", "2": "--int-2", "3": "--int-3", "4": "--int-4", "5-": "--int-5",
  "5+": "--int-6", "6-": "--int-7", "6+": "--int-8-bg", "7": "--int-9-bg" };
const severityRgb = (severityToken) => token(SEVERITY_TOKEN[severityToken]);
const BG = token("--bg");

// ── 記録 ──
const results = [];
function record(id, status, evidence, detail) { results.push({ id, status, evidence, detail }); }
function check(id, ok, evidence, detail) { record(id, ok ? "Pass" : "Fail", evidence, detail); }

// ── snapshot: fixtureをruntimeへ順に入れ、A8で射影する。runtimeごとに別stream (再起動と同じ扱い) ──
const NOW = Date.parse("2024-04-17T23:15:30+09:00");
const GENERATED_AT_JST = "2024/04/17 23:15:30";
const calls = { ...linkedRuntimeCalls, codecs: linkedUnitCodecs };
const clock = { wallTimeMs: NOW, monotonicMs: NOW };
const healthy = { state: "healthy", lastProgressAtMonotonicMs: NOW, lastResponseAtMonotonicMs: NOW };
const FIXTURES = { VXSE43: "37_01_01_240613_VXSE43", VXSE45: "77_01_01_240613_VXSE45" };

// eventIdを渡すとfixtureのEventIDだけを差し替えた別の報にする (容量超過をA1→A4→A8の実経路で起こすため)。
function material(family, eventId = null) {
  const fixture = readFileSync(join(repo, `test/fixtures/${FIXTURES[family]}.xml`), "utf8");
  const xml = eventId == null ? fixture : fixture.replace(/<EventID>[^<]*<\/EventID>/, `<EventID>${eventId}</EventID>`);
  const entered = ingestXmlData({ inputId: `${FIXTURES[family]}:${eventId ?? "fixture"}`, inputSequence: 1, receivedAt: 0,
    origin: "replay", kind: "replay", headType: family, body: Buffer.from(xml) });
  if (entered.kind !== "accepted") throw new Error(`ingest failed: ${entered.diagnostic.reason}`);
  const decoded = decodeMaterial(entered.item);
  if (decoded.kind !== "decoded") throw new Error(`decode failed: ${decoded.diagnostic.reason}`);
  return decoded.material;
}

// 起動→各material受信のたびに射影したsnapshotを返す (起動分は除く)。
function runtime(streamId, materials) {
  let projection = null;
  const project = (step) => {
    const result = projectSnapshot(snapshotInput(step, streamId, NOW,
      { state: "connected", disconnectedAt: null, lastInputAt: NOW }, healthy), projection);
    if (result.kind !== "projected") throw new Error(`projection ${result.kind}`);
    projection = result.state;
    return result.snapshot;
  };
  let step = reduceRuntime(null, { kind: "startup", runId: streamId, clock,
    notificationChannels: { desktop: { kind: "idle" }, sound: { kind: "idle" } },
    restored: { "U-E": { kind: "empty" }, "U-W": { kind: "empty" }, "U-F": { kind: "empty" } } }, calls);
  project(step);
  return materials.map((item, index) => {
    step = reduceRuntime(step.state, { kind: "mailboxCompleted", clock, completion: { kind: "parser",
      messageId: item.inputId, inputId: item.inputId, runId: streamId, encodedByteLength: 0, startedMonotonicMs: NOW,
      completedMonotonicMs: NOW, inputSequence: index + 1, result: { kind: "decoded", material: item } } }, calls);
    return project(step);
  });
}
const [S43, S43_45] = runtime("smoke-a", [material("VXSE43"), material("VXSE45")]);
// expected:O09:12: VXSE45だけを受けたruntimeの採用snapshot (区域0、予想最大3)。
const [S45] = runtime("smoke-b", [material("VXSE45")]);
// A4のcurrent上限512を超えるnormalの別EventIDを513件入れる。513件目が容量超過になり、normalは公開maskでcardが消える。
const S_CAPACITY = runtime("smoke-capacity", Array.from({ length: 513 },
  (_, index) => material("VXSE43", String(index + 1).padStart(14, "0")))).at(-1);
const [CUR43] = S43.current.eew.view.current;
const [CUR45] = S45.current.eew.view.current;
const A8_NOTICE = S43.notices[0];

// 射影で作れない状態の組立て。EEW本体を変えたらA4/A8と同じくcontentRevisionも変える。
function withCurrent(base, current, revision) {
  const eew = base.current.eew;
  return { ...base, current: { ...base.current, eew: { ...eew, contentRevision: revision,
    view: { ...eew.view, contentRevision: revision, current, activeCount: current.length } } } };
}
function withSummary(base, revision, items) {
  return { ...base, current: { ...base.current, eew: { unit: "U-E", contentRevision: revision, items,
    delivery: "summary", reason: "snapshotBudget", originalBytes: 70_000, budgetBytes: 65_536 } } };
}

// ── CDP ──
// 応答しないChromeで後段 (pid指定の終了・server解放・結果保存) へ進めなくならないよう、要求ごとに期限を置く。
const CDP_TIMEOUT_MS = 30_000;
function cdp(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  const pending = new Map();
  let nextId = 0;
  const settle = (id) => {
    const waiter = pending.get(id);
    if (waiter == null) return null;
    pending.delete(id);
    clearTimeout(waiter.timer);
    return waiter;
  };
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = settle(message.id);
    if (waiter == null) return;
    if (message.error != null) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
    else waiter.resolve(message.result);
  });
  // 開いた後のsocket errorはcloseへ続くので、ここでは握って待機中の要求の拒否をcloseに任せる。
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const id of [...pending.keys()]) settle(id).reject(new Error(`CDP socket closed`));
  });
  return {
    opened: Promise.race([new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }),
      sleep(CDP_TIMEOUT_MS).then(() => { throw new Error("CDP socket did not open"); })]),
    close: () => socket.close(),
    send: (method, params = {}, timeoutMs = CDP_TIMEOUT_MS) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error(`${method}: CDP socket not open`));
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => settle(id)?.reject(new Error(`${method}: no CDP response within ${timeoutMs} ms`)), timeoutMs);
      pending.set(id, { resolve, reject, method, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let page;
let browser;
let isolatedContextId;

async function evaluate(expression, contextId) {
  const response = await page.send("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, ...(contextId == null ? {} : { contextId }) });
  if (response.exceptionDetails != null) throw new Error(`evaluate: ${JSON.stringify(response.exceptionDetails)}`);
  return response.result.value;
}
async function waitFor(expression, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(expression);
    if (value != null && value !== false) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}
const chromeNow = () => evaluate("performance.now()");
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const texts = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent)`);
const marks = (name) => evaluate(`performance.getEntriesByName(${JSON.stringify(name)})
  .map((e) => ({ startTime: e.startTime, detail: e.detail }))`);

// smoke側の観測: native EventSourceを透過に包み、生成・close・受信の時刻を記録する。前景復帰の直前/直後の表示も取る。
// 製品コードには測定用event/endpoint/markを足さない (AC06)。
const OBSERVER = `(() => {
  const Native = window.EventSource;
  const log = [];
  let count = 0;
  window.__smoke = { log, vis: [] };
  window.EventSource = class extends Native {
    constructor(url, init) {
      super(url, init);
      const id = ++count;
      this.__smokeId = id;
      log.push({ t: performance.now(), kind: "new", id });
      for (const kind of ["snapshot", "heartbeat"]) this.addEventListener(kind, () => log.push({ t: performance.now(), kind, id }));
      this.addEventListener("error", () => log.push({ t: performance.now(), kind: "error", id, readyState: this.readyState }));
    }
    close() { log.push({ t: performance.now(), kind: "close", id: this.__smokeId }); super.close(); }
  };
  window.__smokeVisibility = (phase) => () => {
    if (document.visibilityState !== "visible") return;
    window.__smoke.vis.push({ phase, t: performance.now(), banner: document.getElementById("banner")?.textContent ?? null,
      logLength: log.length });
  };
  window.addEventListener("visibilitychange", window.__smokeVisibility("before"), true);
})()`;

// PNGの復号はChrome側 (isolated world) で行う。Node側にPNG decoderを足さない。
const DECODE = `async (base64, points) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }),
    { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height,
    pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3)) };
}`;

async function screenshotPixels(label, cssPoints) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDir, `${label}.png`), Buffer.from(data, "base64"));
  const devicePoints = cssPoints.map(([x, y]) => [Math.floor(x * 2), Math.floor(y * 2)]);
  return evaluate(`(${DECODE})(${JSON.stringify(data)}, ${JSON.stringify(devicePoints)})`, isolatedContextId);
}

// 地図各区域の中心 (契約のcenterPixelCss + 地図の内側原点) とcard枠の左辺中央。
async function paintPoints() {
  return evaluate(`(() => {
    const map = document.getElementById("map").getBoundingClientRect();
    const border = document.getElementById("map").clientLeft;
    const cards = [...document.querySelectorAll("#cards .eew-card")].map((card) => {
      const r = card.getBoundingClientRect();
      return [r.left + 2, r.top + r.height / 2];
    });
    return { mapOrigin: [map.left + border, map.top + border], cards };
  })()`);
}
const sameRgb = (a, b) => a.length === 3 && a.every((v, i) => v === b[i]);

// ── server・publish ──
let server;
let sequence = 0;
const htmlPath = join(repo, "reconstruction/src/display/chrome-eew/index.html");
// tscの出力 (rootDir共通祖先=reconstruction/) のうちA9のES moduleが並ぶ平らなdirectory。
const moduleDirectory = join(repo, "reconstruction/dist/chrome-eew/src/display/chrome-eew");
const startServer = (port) => startDisplayServer({ host: "127.0.0.1", port, worker: healthy,
  browserAssets: { htmlPath, moduleDirectory } });

// sequenceは全streamを通して単調に振る。streamIdはsnapshotを作ったruntimeのものを保つ。
async function publish(snapshot, options = {}) {
  sequence += 1;
  const published = { ...snapshot, sequence: options.sequence ?? sequence };
  server.publish(published);
  if (options.ignored) return published;
  const seen = await waitFor(`performance.getEntriesByName("${T5}").some((e) => e.detail.displayVersion.streamId === ${JSON.stringify(published.streamId)}
    && e.detail.displayVersion.sequence === ${published.sequence})`, 15_000);
  if (seen == null) throw new Error(`snapshot ${published.sequence} not received`);
  // 背景tabではrAFが回らないので、前景のときだけ描画の一巡を待つ。
  await evaluate(`document.visibilityState === "hidden" || new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  return published;
}

async function r38(state) {
  const found = await evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) if (walker.currentNode.data.includes("全国通知")) count += 1;
    return { count, r38: document.getElementById("r38")?.textContent ?? null };
  })()`);
  check(`P2-A9-T05:AC07:${state}`, found.count === 1 && found.r38 === "全国通知", "DOM", found);
}

// ── 各検査 ──
async function checkEnvironment(chromeVersion) {
  check("P2-A9-env:chromeVersion", chromeVersion === conditions.chrome.version, "CDP応答",
    { expected: conditions.chrome.version, actual: chromeVersion });
  const env = await evaluate(`({ innerWidth, innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState,
    focus: document.hasFocus(), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches })`);
  check("P2-A9-env:viewport", env.innerWidth === 1440 && env.innerHeight === 900 && env.dpr === 2, "DOM", env);
  check("P2-A9-env:foregroundTab", env.visibility === "visible", "DOM", env);
  check("P2-A9-env:motionFull", env.reducedMotion === false && conditions.chrome.motion === "full", "DOM", env);
}

async function checkVxse43(published) {
  const expected = paint.VXSE43;
  const card = await evaluate(`[...document.querySelectorAll("#cards .eew-card")].map((c) => ({
    head: c.querySelector(".eew-card-head").textContent, time: c.querySelector(".eew-card-time").textContent,
    areas: [...c.querySelectorAll(".eew-card-area")].map((a) => a.textContent) }))`);
  const only = card[0];
  const areaRowsOk = only != null && only.areas.length === expected.areas.length
    && expected.areas.every((area, i) => only.areas[i].startsWith(`${area.code}: ${area.displayToken}`));
  check("P2-A9-T02:VXSE43:card", card.length === 1 && only.head.includes("[通常]") && only.head.includes(CUR43.eventId)
    && only.head.includes(`最大${expected.cardDisplayToken}`) && only.time === "2024/04/17 23:14:59" && areaRowsOk,
  "DOM", { card, expectedRows: expected.areas.map((a) => `${a.code}: ${a.displayToken}`) });

  const points = await paintPoints();
  const centers = expected.areas.map((a) => [points.mapOrigin[0] + a.centerPixelCss[0], points.mapOrigin[1] + a.centerPixelCss[1]]);
  const shot = await screenshotPixels("vxse43", [...centers, points.cards[0]]);
  const areaPixels = expected.areas.map((a, i) => ({ code: a.code, severityToken: a.severityToken,
    expected: severityRgb(a.severityToken), actual: shot.pixels[i] }));
  const cardPixel = { severityToken: expected.cardSeverityToken, expected: severityRgb(expected.cardSeverityToken),
    actual: shot.pixels[expected.areas.length] };
  check("P2-A9-T02:VXSE43:paintPixels", shot.width === 2880 && shot.height === 1800
    && areaPixels.every((p) => sameRgb(p.actual, p.expected)) && sameRgb(cardPixel.actual, cardPixel.expected),
  "screenshot画素", { screenshot: "evidence/vxse43.png", size: [shot.width, shot.height], areaPixels, cardPixel });

  const t5 = (await marks(T5)).filter((m) => m.detail.displayVersion.sequence === published.sequence);
  const t6 = (await marks(T6)).filter((m) => m.detail.displayVersion.sequence === published.sequence);
  const detail = t6[0]?.detail;
  check("P2-A9-T04:markers:VXSE43", t5.length === 1 && t6.length === 1 && detail.operation === "normal"
    && detail.subject === CUR43.subject && detail.cardMarkerId === `card:${CUR43.subject}`
    && detail.mapMarkerId === `map:${CUR43.subject}`
    && JSON.stringify(detail.mapAreaCodes) === JSON.stringify(expected.areas.map((a) => a.code))
    && t6[0].startTime >= t5[0].startTime && t5[0].detail.name === T5 && detail.name === T6,
  "performance entry", { t5, t6, geometrySha256: contractGeometrySha });
}

async function checkGeometryHash() {
  const served = await evaluate(`(async () => {
    const geometry = await import("/chrome-eew/geometry.js");
    const json = geometry.canonicalGeometryJson();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    return { sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      areas: geometry.GEOMETRY_AREAS };
  })()`);
  const areasMatch = JSON.stringify(served.areas) === JSON.stringify(paint.VXSE43.areas.map((a) => ({ code: a.code, rect: a.rect })));
  check("P2-A9-T02:geometrySha256", served.sha256 === contractGeometrySha && served.sha256 === conditions.geometrySha256
    && areasMatch, "Chrome内のsha256 (配信module)",
  { served: served.sha256, contract: contractGeometrySha, conditions: conditions.geometrySha256, areasMatch });
}

async function checkClockProbe() {
  const response = await evaluate(`window.fleqRespondClockProbe("smoke-probe-1")`);
  check("P2-A9-T04:clockProbe", response?.probeId === "smoke-probe-1"
    && typeof response.chromeReceivedMonotonicMs === "number" && typeof response.chromeSentMonotonicMs === "number"
    && response.chromeSentMonotonicMs >= response.chromeReceivedMonotonicMs, "CDP応答 (Runtime.evaluate)", response);
}

async function checkMetadataOnly() {
  // AC04/D-AC12の先行証拠: EEW内容版が同じsnapshotでcard/mapのDOMノードが同一のまま残る。
  await evaluate(`document.querySelectorAll("#cards .eew-card, #map .map-area").forEach((n) => { n.__smokeKeep = true; })`);
  const before = await evaluate(`document.querySelectorAll("#cards .eew-card, #map .map-area").length`);
  const published = await publish({ ...S43, channels: { desktop: "available", sound: "unavailable" },
    connection: { state: "reconnecting", disconnectedAt: NOW, lastInputAt: NOW } });
  const after = await evaluate(`(() => { const nodes = [...document.querySelectorAll("#cards .eew-card, #map .map-area")];
    return { count: nodes.length, kept: nodes.filter((n) => n.__smokeKeep === true).length }; })()`);
  const t6 = (await marks(T6)).filter((m) => m.detail.displayVersion.sequence === published.sequence);
  const channels = await texts("#channels .channel");
  check("P2-A9-T03:AC04:metadataOnlyNoReinit", before === 10 && after.count === 10 && after.kept === 10 && t6.length === 0
    && channels.includes("音声通知: 使えない"), "DOM (node同一性)", { before, after, t6Count: t6.length, channels });
}

async function checkRemoval() {
  await publish(S43_45);
  const both = await texts("#cards .eew-card-head");
  // expected:O09:12の採用snapshot (VXSE45だけを受けたruntime) へ置き換わると、VXSE43のcardと塗りが消える。
  const published = await publish(S45);
  const cards = await evaluate(`[...document.querySelectorAll("#cards .eew-card")].map((c) => ({
    head: c.querySelector(".eew-card-head").textContent, time: c.querySelector(".eew-card-time").textContent,
    areas: c.querySelectorAll(".eew-card-area").length }))`);
  check("P2-A9-T02:VXSE45:card", cards.length === 1 && cards[0].head.includes("VXSE45")
    && cards[0].head.includes(`最大${paint.VXSE45.cardDisplayToken}`) && cards[0].time === "2024/04/17 23:14:57"
    && cards[0].areas === paint.VXSE45.areas.length, "DOM", { streamId: S45.streamId, cards });
  const bodyText = await evaluate("document.body.textContent");
  const mapCount = await evaluate(`document.querySelectorAll("#map .map-area").length`);
  check("P2-A9-T03:R59:removedAndKept", both.length === 2 && cards.length === 1 && !cards[0].head.includes("VXSE43")
    && cards.every((c) => c.head.trim() !== "") && mapCount === 0 && !bodyText.includes("取消") && !bodyText.includes("終了"),
  "DOM", { before: both, after: cards.map((c) => c.head), mapCount });

  const points = await paintPoints();
  const centers = paint.VXSE43.areas.map((a) => [points.mapOrigin[0] + a.centerPixelCss[0], points.mapOrigin[1] + a.centerPixelCss[1]]);
  const shot = await screenshotPixels("vxse45-only", [...centers, points.cards[0]]);
  const cleared = shot.pixels.slice(0, 9).every((p) => sameRgb(p, BG));
  const cardPixel = { expected: severityRgb(paint.VXSE45.cardSeverityToken), actual: shot.pixels[9] };
  check("P2-A9-T02:VXSE45:emptyMapPixels", cleared && sameRgb(cardPixel.actual, cardPixel.expected), "screenshot画素",
    { screenshot: "evidence/vxse45-only.png", formerCenters: shot.pixels.slice(0, 9), background: BG, cardPixel });

  const t6 = (await marks(T6)).filter((m) => m.detail.displayVersion.streamId === S45.streamId
    && m.detail.displayVersion.sequence === published.sequence);
  check("P2-A9-T04:markers:VXSE45emptyMap", t6.length === 1 && t6[0].detail.subject === CUR45.subject
    && Array.isArray(t6[0].detail.mapAreaCodes) && t6[0].detail.mapAreaCodes.length === 0, "performance entry", { t6 });
  await r38("afterCardRemoval");
}

async function checkT01() {
  const cardsBefore = await texts("#cards .eew-card-head");
  const t5Before = (await marks(T5)).length;
  const invalid = await publish({ ...S43, schemaVersion: 2 }, { ignored: true });
  // 識別子だけの不完全な版。境界で拒まれ、T5も表示も動かない。
  const identityOnly = await publish({ schemaVersion: 1, streamId: S43.streamId }, { ignored: true });
  const older = await publish(withCurrent(S43, [CUR43], "smoke:older"), { ignored: true, sequence: 1 });
  // 番兵: 同じstreamの新しい有効snapshot。SSEは順序どおりに届くので、番兵のT5が見えた時点で先の2つは処理済み。
  const sentinel = await publish(S43);
  const t5 = await marks(T5);
  const cardsAfter = await texts("#cards .eew-card-head");
  check("P2-A9-T01:schemaAndSequenceChecked", identityOnly.sequence != null && t5.length === t5Before + 1
    && t5.at(-1).detail.displayVersion.sequence === sentinel.sequence && JSON.stringify(cardsBefore) === JSON.stringify(cardsAfter),
  "DOM・performance entry", { invalidSequence: invalid.sequence, olderSequence: older.sequence, sentinelSequence: sentinel.sequence,
    t5Before, t5After: t5.length, cardsBefore, cardsAfter });
}

// 上端の扱いと未知の色 (系列1本): To=over→「{From}程度以上」・色From、To=missing→色From、To=不明→未知色、
// range→生表記・未知色。card枠 (maximum To=不明) も未知色。
async function checkIntensityBounds() {
  const value = { four: { kind: "number", value: 4, raw: "4" }, fiveLower: { kind: "text", value: "5-", raw: "5-" },
    over: { kind: "text", value: "over", raw: "over" }, unknown: { kind: "unknown", raw: "不明" }, missing: { kind: "missing" },
    range: { kind: "range", bound: "lower", value: 5, raw: "5弱以上" } };
  const intensity = (from, to) => ({ from, to, condition: null, description: null });
  const areas = [["622", intensity(value.fiveLower, value.over), "5弱程度以上", token("--int-5")],
    ["632", intensity(value.four, value.missing), "4", token("--int-4")],
    ["752", intensity(value.four, value.unknown), "4〜不明", token("--fg-faint")],
    ["751", intensity(value.range, value.range), "5弱以上", token("--fg-faint")]];
  const current = { ...CUR43, prediction: { maximum: intensity(value.four, value.unknown), areaCoverage: "present",
    areas: areas.map(([code, item]) => ({ code, intensity: item })) } };
  await publish(withCurrent(S43, [current], "smoke:bounds"));
  const rows = await texts("#cards .eew-card-area");
  const head = await text("#cards .eew-card-head");
  const points = await paintPoints();
  const center = (code) => paint.VXSE43.areas.find((a) => a.code === code).centerPixelCss;
  const shot = await screenshotPixels("intensity-bounds", [...areas.map(([code]) =>
    [points.mapOrigin[0] + center(code)[0], points.mapOrigin[1] + center(code)[1]]), points.cards[0]]);
  const pixels = areas.map(([code, , , expected], i) => ({ code, expected, actual: shot.pixels[i] }));
  const cardPixel = { expected: token("--fg-faint"), actual: shot.pixels[areas.length] };
  check("P2-A9-T02:AC03:intensityBoundsAndUnknownColor", JSON.stringify(rows) === JSON.stringify(areas.map(([code, , d]) => `${code}: ${d}`))
    && head.includes("最大4〜不明") && pixels.every((p) => sameRgb(p.actual, p.expected)) && sameRgb(cardPixel.actual, cardPixel.expected),
  "DOM・screenshot画素", { rows, head, pixels, cardPixel, screenshot: "evidence/intensity-bounds.png" });
}

// AC04: 容量超過でnormalのcardが消えても (公開mask)、無発令と区別できる行が出る。snapshotは実経路の射影そのもの。
async function checkCapacityExceeded() {
  const row = S_CAPACITY.current.eew.items[0];
  const wire = { capacityExceeded: row.admission.capacityExceeded, unavailable: row.unavailable, activeCount: row.activeCount,
    current: S_CAPACITY.current.eew.view.current.length };
  await publish(S_CAPACITY);
  const rows = await texts("#capacity .eew-capacity");
  const cardCount = await evaluate(`document.querySelectorAll("#cards .eew-card").length`);
  check("P2-A9-T03:AC04:capacityExceededNotNoAlert", wire.capacityExceeded === 1 && wire.current === 0
    && JSON.stringify(rows) === JSON.stringify(["[通常] 表示できない報がある（容量超過 1 件）"]) && cardCount === 0,
  "DOM (A1→A4→A8の実経路のsnapshot)", { wire, rows, cardCount });
}

async function checkNotices() {
  const sourceNull = { ...A8_NOTICE, id: "smoke-source-null", targetId: "smoke-source-null", source: null };
  const truncated = { ...A8_NOTICE, id: "smoke-truncated", targetId: "smoke-truncated",
    source: { ...A8_NOTICE.source, office: "大阪管区気象台", officeTruncated: true } };
  const training = { ...A8_NOTICE, id: "smoke-training", targetId: "smoke-training", operation: "training" };
  await publish({ ...S45, notices: [A8_NOTICE, sourceNull, truncated, training] });
  const rows = await texts("#notices .notice");
  const confirmation = await texts("#confirmation .confirmation");
  check("P2-A9-T06:AC09:noticeA8Text", A8_NOTICE.source != null && A8_NOTICE.source.office == null
    && rows[0] === `[通常] ${A8_NOTICE.text}`, "DOM", { a8Notice: A8_NOTICE, row: rows[0] });
  check("P2-A9-T06:AC09:noticeSourceNull", rows[1] === `[通常] ${A8_NOTICE.text}`, "DOM", { row: rows[1] });
  check("P2-A9-T06:AC09:noticeOfficeTruncated", rows[2] === `[通常] ${A8_NOTICE.text}　大阪管区気象台（切詰め）`, "DOM", { row: rows[2] });
  check("P2-A9-T06:AC09:noticeTraining", rows[3] === `[訓練] ${A8_NOTICE.text}`
    && confirmation.some((row) => row.startsWith("訓練確認状態")), "DOM", { row: rows[3], confirmation });
}

async function checkChannels() {
  await publish({ ...S45, channels: { desktop: "checking", sound: "available" } });
  const first = await texts("#channels .channel");
  await publish({ ...S45, channels: { desktop: "unavailable", sound: "isolated" } });
  const second = await texts("#channels .channel");
  check("P2-A9-T06:AC09:channels4States", JSON.stringify(first) === JSON.stringify(["デスクトップ通知: 確認中", "音声通知: 使える"])
    && JSON.stringify(second) === JSON.stringify(["デスクトップ通知: 使えない", "音声通知: 隔離中"]), "DOM", { first, second });
}

async function checkConnectionAndWorker() {
  const lines = {};
  for (const connection of [{ state: "connected", disconnectedAt: null, lastInputAt: NOW },
    { state: "reconnecting", disconnectedAt: NOW, lastInputAt: NOW }, { state: "stopped", disconnectedAt: NOW, lastInputAt: NOW }]) {
    await publish({ ...S45, connection });
    lines[connection.state] = await text("#connection");
  }
  check("P2-A9-T06:AC09:connection3States", lines.connected.startsWith("接続: 接続中 / 切断: 未切断")
    && lines.reconnecting.startsWith(`接続: 再接続中 / 切断: ${GENERATED_AT_JST}`)
    && lines.stopped.startsWith("接続: 停止 / 切断:"), "DOM", lines);

  const workers = {};
  for (const state of ["stalled", "unresponsive", "stopped"]) {
    await publish({ ...S45, worker: { ...healthy, state } });
    workers[state] = { line: await text("#connection"), banner: await text("#banner") };
  }
  await publish({ ...S45, worker: healthy });
  const recovered = await text("#banner");
  check("P2-A9-T06:AC09:workerStopFamily", Object.values(workers).every((w) => w.line.includes("（停止系）") && w.banner === STALE_BANNER)
    && recovered === "", "DOM", { workers, bannerAfterHealthySnapshot: recovered });
}

async function checkConfirmation() {
  const withConfirmation = (base, normal, training) => {
    const [n, t, s] = base.current.eew.items;
    const items = [{ ...n, confirmation: normal }, { ...t, confirmation: training }, s];
    return { ...base, current: { ...base.current, eew: { ...base.current.eew, items } } };
  };
  const confirmed = { state: "confirmed", confirmedAt: NOW };
  const rows = {};
  for (const state of ["confirmed", "partial", "unconfirmed"]) {
    await publish(withConfirmation(S45, state === "confirmed" ? confirmed : { state, confirmedAt: null }, confirmed));
    rows[state] = await texts("#confirmation .confirmation");
  }
  // training/testは表示中だけ: 訓練cardを足すと訓練行が出る。試験は試験noticeで出す。
  const trainingCurrent = { ...CUR45, operation: "training", subject: CUR45.subject.replace("normal/", "training/") };
  await publish({ ...withConfirmation(withCurrent(S45, [CUR45, trainingCurrent], "smoke:training"), confirmed, { state: "partial", confirmedAt: null }),
    notices: [{ ...A8_NOTICE, id: "smoke-test", targetId: "smoke-test", operation: "test" }] });
  const shown = await texts("#confirmation .confirmation");
  const trainingCard = await texts("#cards .eew-card-head");
  check("P2-A9-T06:AC09:confirmation3States", JSON.stringify(rows.confirmed) === JSON.stringify([`通常確認状態: 確認済み (${GENERATED_AT_JST})`])
    && JSON.stringify(rows.partial) === JSON.stringify(["通常確認状態: 一部確認"])
    && JSON.stringify(rows.unconfirmed) === JSON.stringify(["通常確認状態: 未確認"])
    && shown.length === 3 && shown[1] === "訓練確認状態: 一部確認" && shown[2].startsWith("試験確認状態:")
    && trainingCard.some((h) => h.startsWith("[訓練]")), "DOM", { rows, shownWithTrainingCardAndTestNotice: shown, trainingCard });
}

async function checkSummary() {
  await publish(S43);
  const [n, t, s] = S43.current.eew.items;
  const items = [{ ...n, activeCount: 2, highestSeverity: "warning", updatedAt: Date.parse("2024-04-17T23:14:59+09:00") },
    { ...t, activeCount: 1, highestSeverity: "forecast", updatedAt: null, confirmation: { state: "partial", confirmedAt: null } }, s];
  await publish(withSummary(S43, "smoke:summary", items));
  const rows = await texts("#cards .eew-summary");
  const cardCount = await evaluate(`document.querySelectorAll("#cards .eew-card").length`);
  const confirmation = await texts("#confirmation .confirmation");
  const bodyText = await evaluate("document.body.textContent");
  const points = await paintPoints();
  const centers = paint.VXSE43.areas.map((a) => [points.mapOrigin[0] + a.centerPixelCss[0], points.mapOrigin[1] + a.centerPixelCss[1]]);
  const shot = await screenshotPixels("summary", centers);
  check("P2-A9-T06:AC04:summary", JSON.stringify(rows) === JSON.stringify([
    "[通常] 2件 / 警報 / 更新: 2024/04/17 23:14:59 / 詳細省略中", "[訓練] 1件 / 予報 / 更新: 時刻不明 / 詳細省略中"])
    && cardCount === 0 && confirmation.some((row) => row === "訓練確認状態: 一部確認") && !bodyText.includes("無発令")
    && shot.pixels.every((p) => sameRgb(p, BG)), "DOM・screenshot画素",
  { rows, cardCount, confirmation, screenshot: "evidence/summary.png", formerCenters: shot.pixels });
  await r38("summary");
}

async function checkTimezones() {
  const summaryItems = (() => {
    const [n, t, s] = S43.current.eew.items;
    return [{ ...n, activeCount: 1, highestSeverity: "warning", updatedAt: Date.parse("2024-04-17T23:14:59+09:00") },
      { ...t, activeCount: 1, highestSeverity: "forecast", updatedAt: null }, s];
  })();
  for (const timezoneId of ["UTC", "Asia/Tokyo"]) {
    await page.send("Emulation.setTimezoneOverride", { timezoneId });
    const applied = await evaluate("({ offset: new Date(0).getTimezoneOffset(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone })");
    const expectedOffset = timezoneId === "UTC" ? 0 : -540;
    await publish(withCurrent(S43, [CUR43], `smoke:tz:${timezoneId}:43`));
    const full43 = await texts("#cards .eew-card-time");
    await publish(withCurrent(S45, [CUR45], `smoke:tz:${timezoneId}:45`));
    const full45 = await texts("#cards .eew-card-time");
    await publish(withSummary(S43, `smoke:tz:${timezoneId}:summary`, summaryItems));
    const summary = await texts("#cards .eew-summary");
    const bodyText = await evaluate("document.body.textContent");
    check(`P2-A9-T06:AC10:time:${timezoneId}`, JSON.stringify(full43) === JSON.stringify(["2024/04/17 23:14:59"])
      && JSON.stringify(full45) === JSON.stringify(["2024/04/17 23:14:57"])
      && summary[0].includes("更新: 2024/04/17 23:14:59") && summary[1].includes("更新: 時刻不明")
      && !bodyText.includes(GENERATED_AT_JST) && applied.offset === expectedOffset,
    "DOM (Emulation.setTimezoneOverride)", { applied, full43, full45, summary, generatedAtJst: GENERATED_AT_JST });
  }
}

async function checkHtmlNotInterpreted() {
  const evil = {
    eventId: "<script>window.__fleqXss=(window.__fleqXss||0)+1</script>",
    code: `<img src=x onerror="window.__fleqXss=(window.__fleqXss||0)+1">`,
    condition: "&lt;b&gt;&amp;",
    text: `<img src=x onerror="window.__fleqXss=(window.__fleqXss||0)+1">\n行2[truncated:fieldLimit]`,
    office: "<script>window.__fleqXss=1</script>&lt;i&gt;",
  };
  const benign = { eventId: "EVENT-BENIGN", code: "AREA-BENIGN", condition: "COND-BENIGN", text: "notice benign", office: "office benign" };
  const build = (strings, revision) => {
    const [first, ...rest] = CUR43.prediction.areas;
    const extra = { code: strings.code, intensity: rest[0].intensity };
    const current = { ...CUR43, eventId: strings.eventId, prediction: { ...CUR43.prediction,
      areas: [{ ...first, intensity: { ...first.intensity, condition: strings.condition } }, ...rest, extra] } };
    return { ...withCurrent(S43, [current], revision), notices: [{ ...A8_NOTICE, text: strings.text,
      source: { ...A8_NOTICE.source, office: strings.office, officeTruncated: false } }] };
  };
  const shape = `(() => ({ elements: document.getElementsByTagName("*").length,
    executable: document.querySelectorAll("script, img, iframe, object, embed, svg, link").length,
    head: document.querySelector("#cards .eew-card-head").textContent,
    areas: [...document.querySelectorAll("#cards .eew-card-area")].map((n) => n.textContent),
    notice: document.querySelector("#notices .notice").textContent, fired: window.__fleqXss ?? 0 }))()`;
  await publish(build(benign, "smoke:xss:benign"));
  const benignShape = await evaluate(shape);
  await publish(build(evil, "smoke:xss:evil"));
  await sleep(1000);
  const evilShape = await evaluate(shape);
  const literal = evilShape.head.includes(evil.eventId) && evilShape.areas[0].includes(evil.condition)
    && evilShape.areas.at(-1) === `${evil.code}: 4` && evilShape.notice === `[通常] ${evil.text}　${evil.office}`;
  check("P2-A9-T05:AC08:htmlNotInterpreted", benignShape.elements === evilShape.elements
    && benignShape.executable === evilShape.executable && evilShape.fired === 0 && literal, "DOM",
  { benign: benignShape, evil: evilShape, evilStrings: evil });
}

async function checkHeartbeatOnlyStopped() {
  await publish(S45);
  const t5Before = (await marks(T5)).length;
  const logBefore = await evaluate("window.__smoke.log.length");
  const stopped = { state: "stopped", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null };
  server.setWorker(stopped);
  server.heartbeat();
  await waitFor(`window.__smoke.log.slice(${logBefore}).some((e) => e.kind === "heartbeat")`, 3000);
  const first = { line: await text("#connection"), banner: await text("#banner") };
  const logMiddle = await evaluate("window.__smoke.log.length");
  server.heartbeat();
  await waitFor(`window.__smoke.log.slice(${logMiddle}).some((e) => e.kind === "heartbeat")`, 3000);
  const second = { line: await text("#connection"), banner: await text("#banner") };
  const t5After = (await marks(T5)).length;
  check("P2-A9-T06:a:heartbeatOnlyStopped", t5After === t5Before && [first, second].every((s) =>
    s.line.includes("worker: 停止（停止系）") && s.banner === STALE_BANNER), "DOM", { first, second, t5Before, t5After });
  server.setWorker(healthy);
  server.heartbeat();
  await waitFor(`document.getElementById("banner").textContent === ""`, 3000);
}

const lastEventBefore = (log, t) => log.filter((e) => (e.kind === "snapshot" || e.kind === "heartbeat") && e.t <= t).at(-1);

async function checkStaleReconnect() {
  const port = server.port;
  const t5Before = (await marks(T5)).length;
  const cardsBefore = await texts("#cards .eew-card-head");
  // serverは開いたまま、不正な入力だけを流し続ける: worker.stateが4値外のheartbeatと、識別子だけのsnapshot。
  // どちらも境界で拒まれるので受信時刻は進まず、最後の有効な受信から45秒でstale再接続になるはず。
  server.setWorker({ state: "bogus", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null });
  const logStart = await evaluate("window.__smoke.log.length");
  const last = lastEventBefore(await evaluate("window.__smoke.log"), Number.POSITIVE_INFINITY);
  let closed = null;
  for (let i = 0; closed == null && i < 8; i += 1) {
    sequence += 1;
    server.publish({ schemaVersion: 1, streamId: S43.streamId, sequence });
    closed = await waitFor(`window.__smoke.log.slice(${logStart}).find((e) => e.kind === "close") ?? null`, 10_000, 500);
  }
  const bannerWhileInvalid = await text("#banner");
  const log = await evaluate("window.__smoke.log");
  if (closed == null) {
    check("P2-A9-T06:b:staleReconnect", false, "EventSource観測log", { reason: "no close within 80 s", log: log.slice(logStart) });
    await closeServer("staleReconnect");
    server = await startServer(port);
    return null;
  }
  const invalidReceived = log.slice(logStart).filter((e) => (e.kind === "snapshot" || e.kind === "heartbeat") && e.t < closed.t);
  const invalidDetail = { lastValidEvent: last, invalidReceived: invalidReceived.length, t5Before,
    t5After: (await marks(T5)).length, cardsBefore, cardsAfter: await texts("#cards .eew-card-head") };
  // 再接続先を落としてから再起動し、503の枠取りへ進む。
  await closeServer("afterInvalid");
  const reopened = log.find((e) => e.kind === "new" && e.t >= closed.t);
  // 503で閉じた接続からの回復: 再起動直後にA8の同時接続上限 (http-sse.ts:21 CLIENT_LIMIT=8) をsmoke側の接続で埋め、
  // pageの再試行を503にしてEventSourceをCLOSEDにする。枠を空けた後、stale中の周期検査が張り直すことを見る。
  server = await startServer(port);
  const holders = Array.from({ length: 8 }, () => new AbortController());
  const holderStatuses = (await Promise.all(holders.map((holder) =>
    fetch(`http://127.0.0.1:${port}/events`, { signal: holder.signal })))).map((response) => response.status);
  const slotsHeld = server.clientCount();
  const failed = reopened == null ? null
    : await waitFor(`window.__smoke.log.find((e) => e.kind === "error" && e.id === ${reopened.id} && e.readyState === 2) ?? null`, 15_000, 200);
  for (const holder of holders) holder.abort();
  const recovered = failed == null ? null
    : await waitFor(`window.__smoke.log.find((e) => e.kind === "new" && e.t > ${failed.t}) ?? null`, 20_000, 200);
  const published = await publish(withCurrent(S43, [CUR43], "smoke:afterStale"));
  const after = { heads: await texts("#cards .eew-card-head"), banner: await text("#banner"), clients: server.clientCount() };
  const finalLog = await evaluate("window.__smoke.log");
  // 503で閉じた後に届いた有効な版だけを数える (それ以前はstale再接続先へ再送された不正な版)。
  const delivered = finalLog.filter((e) => e.kind === "snapshot" && e.t > (failed?.t ?? closed.t));
  const gap = closed.t - last.t;
  const settled = after.heads.length === 1 && after.heads[0].includes("VXSE43") && after.banner === "" && after.clients === 1;
  // 不正な入力は受信時刻・T5・表示を動かさず、その後の有効な版で通常どおり進む。
  check("P2-A9-T01:invalidInputDoesNotRefresh", invalidReceived.length > 0 && invalidDetail.t5After === t5Before
    && JSON.stringify(invalidDetail.cardsAfter) === JSON.stringify(cardsBefore) && closed.t - last.t >= 45_000
    && bannerWhileInvalid === STALE_BANNER && settled, "EventSource観測log・DOM・performance entry", { ...invalidDetail, after });
  check("P2-A9-T06:b:staleReconnect", gap >= 45_000 && gap <= 45_000 + 15_000 + 1_000 && bannerWhileInvalid === STALE_BANNER
    && reopened != null && reopened.t - closed.t < 50 && closed.id !== reopened.id && settled,
  "EventSource観測log・DOM・server clientCount", { lastValidEvent: last, closed, reopened, gapMs: gap, bannerWhileInvalid, after });
  const recoveryDetail = { holderStatuses, slotsHeld, closedBy503: failed, reopenedAfterSlotsFreed: recovered,
    publishedSequence: published.sequence, delivered, after };
  // 場所取りが1本でも200でない (pageの再試行が先に枠を取った等) なら、503の再現そのものが成立していない。
  if (holderStatuses.some((code) => code !== 200)) {
    record("P2-A9-T06:b:closedConnectionRecovered", "未確認", "EventSource観測log・server clientCount",
      { ...recoveryDetail, reason: "場所取り接続が上限を埋められず、pageを503にできなかった" });
  } else {
    check("P2-A9-T06:b:closedConnectionRecovered", slotsHeld === 8 && failed != null && recovered != null
      && recovered.t - failed.t <= 15_000 + 1_000 && delivered.length > 0 && delivered.every((e) => e.id === recovered.id)
      && settled, "EventSource観測log・DOM・server clientCount", recoveryDetail);
  }
  return closed.t;
}

async function checkForegroundImmediate(tickPhase) {
  const id = "P2-A9-T06:c:foregroundImmediate";
  await evaluate(`document.addEventListener("visibilitychange", window.__smokeVisibility("after")); true`);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const hidden = await waitFor(`document.visibilityState === "hidden"`, 5000);
  if (hidden == null) {
    record(id, "未確認", "DOM", { reason: "別tabを前面にしても元tabがhiddenにならなかった" });
    await browser.send("Target.closeTarget", { targetId });
    return;
  }
  // 周期検査の位相から見て、45秒到達が次の周期tickの約7.5秒前になる時刻に最後の受信を置く。
  const now = await chromeNow();
  const phase = (((now - tickPhase) % 15_000) + 15_000) % 15_000;
  await sleep((7_500 - phase + 15_000) % 15_000);
  await publish(withCurrent(S45, [CUR45], "smoke:beforeHidden"));
  const port = server.port;
  await closeServer("beforeHidden");
  const log = await evaluate("window.__smoke.log");
  const last = lastEventBefore(log, Number.POSITIVE_INFINITY);
  const target = last.t + 45_000 + 1_500;
  for (let t = await chromeNow(); t < target; t = await chromeNow()) await sleep(Math.min(1_000, target - t));
  const bannerBefore = await text("#banner");
  const visStart = await evaluate("window.__smoke.vis.length");
  await page.send("Page.bringToFront");
  const vis = await waitFor(`window.__smoke.vis.length >= ${visStart + 2} ? window.__smoke.vis.slice(${visStart}) : null`, 5000);
  const finalLog = await evaluate("window.__smoke.log");
  await browser.send("Target.closeTarget", { targetId });
  const before = vis?.find((v) => v.phase === "before");
  const after = vis?.find((v) => v.phase === "after");
  let nextTick = tickPhase;
  while (nextTick < last.t + 45_000) nextTick += 15_000;
  const closedInDispatch = before != null && after != null
    && finalLog.some((e) => e.kind === "close" && e.t >= before.t && e.t <= after.t)
    && finalLog.some((e) => e.kind === "new" && e.t >= before.t && e.t <= after.t);
  const detail = { lastEvent: last, thresholdAt: last.t + 45_000, nextPeriodicTickAt: nextTick, bannerBefore, before, after,
    events: finalLog.filter((e) => e.t > last.t) };
  if (bannerBefore !== "") {
    record(id, "未確認", "EventSource観測log・DOM", { ...detail, reason: "前景へ戻す前に周期検査がstaleにしていた (位相合わせ失敗)" });
  } else {
    check(id, before?.banner === "" && after?.banner === STALE_BANNER && closedInDispatch
      && after?.t - last.t >= 45_000 && after?.t < nextTick, "visibilitychange dispatch内の観測・EventSource観測log", detail);
  }
  server = await startServer(port);
  await publish(S43);
  check("P2-A9-T06:c:recoveredAfterForeground", (await text("#banner")) === "" && server.clientCount() === 1, "DOM・server clientCount",
    { banner: await text("#banner"), clients: server.clientCount() });
}

async function checkMarkNamesOnly() {
  const names = await evaluate(`[...new Set(performance.getEntriesByType("mark").map((e) => e.name))]`);
  check("P2-A9-T04:markNamesOnly", names.every((name) => name === T5 || name === T6), "performance entry", { names });
}

// 初回snapshot前も接続・stale・heartbeat由来のworkerを状態行に出す。
async function checkStatusBeforeFirstSnapshot() {
  const logStart = await evaluate("window.__smoke.log.length");
  server.heartbeat();
  await waitFor(`window.__smoke.log.slice(${logStart}).some((e) => e.kind === "heartbeat")`, 3000);
  const status = { connection: await text("#connection"), banner: await text("#banner") };
  check("P2-A9-T06:AC09:statusBeforeFirstSnapshot", status.connection === "接続: snapshot未受信 / worker: 正常 / 受信: 無受信45秒未満"
    && status.banner === "", "DOM", status);
}

// smoke条件の自己hashとfixtureの実bytesを照合する。sha256はChrome内で計算する (Node側に依存を足さない)。
async function checkConditionsHashes() {
  const conditionsPath = join(repo, "reconstruction/test/eew-e01/evidence/chrome-smoke-conditions.json");
  const zeroed = readFileSync(conditionsPath, "utf8").replace(conditions.conditionsSha256, "0".repeat(64));
  const files = { conditions: Buffer.from(zeroed, "utf8").toString("base64"), ...Object.fromEntries(Object.entries(FIXTURES)
    .map(([family, file]) => [family, readFileSync(join(repo, `test/fixtures/${file}.xml`)).toString("base64")])) };
  const actual = await evaluate(`(async (files) => {
    const out = {};
    for (const [name, base64] of Object.entries(files)) {
      const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      out[name] = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return out;
  })(${JSON.stringify(files)})`);
  const fixtures = Object.keys(FIXTURES).map((family) => ({ fixtureId: paint[family].fixtureId, actual: actual[family],
    conditions: conditions.fixtureSha256[paint[family].fixtureId], contract: paint[family].fixtureSha256 }));
  check("P2-A9-env:conditionsAndFixtureHashes", actual.conditions === conditions.conditionsSha256
    && fixtures.every((f) => f.actual === f.conditions && f.actual === f.contract), "Chrome内のsha256",
  { conditionsSelfHash: { actual: actual.conditions, recorded: conditions.conditionsSha256 }, fixtures });
}

// AC05: 先行証拠。全active EventID bounds・P4 GIS・E04/E25/E26・1000×3正式E01は未実施なのでPassと報告しない。
const PRECEDING = [
  { id: "D-AC02", smokeRecords: ["P2-A9-T03:R59:removedAndKept", "P2-A9-T03:AC04:capacityExceededNotNoAlert",
    "P2-A9-T06:AC04:summary", "P2-A9-T06:AC09:noticeA8Text"],
    notYet: "P4の全災害カード・現在ページ外の取消反映" },
  { id: "D-AC12", smokeRecords: ["P2-A9-T03:AC04:metadataOnlyNoReinit"], notYet: "P4のcamera復帰・ページ停止解除・版付き詳細" },
  { id: "D-AC14", smokeRecords: ["P2-A9-T02:VXSE43:paintPixels", "P2-A9-T03:R59:removedAndKept"],
    notYet: "全active EventID集合のbounds・P4 GIS・交差取消の系列" },
  { id: "D-AC24", smokeRecords: ["P2-A9-T04:markers:VXSE43", "P2-A9-T04:markers:VXSE45emptyMap"],
    notYet: "1000×3正式E01 (A10)・E04/E25/E26。T6候補は正式T6ではない" },
];

// ── 実行 ──
let chrome;
let profileDir;

async function main() {
  mkdirSync(evidenceDir, { recursive: true });
  server = await startServer(0);
  const url = `http://127.0.0.1:${server.port}/`;
  profileDir = mkdtempSync(join(tmpdir(), "fleq-chrome-eew-smoke-"));
  chrome = spawn(CHROME, ["--remote-debugging-port=0", `--user-data-dir=${profileDir}`, ...CHROME_FLAGS, "about:blank"],
    { stdio: "ignore" });
  let spawnError = null;
  chrome.once("error", (error) => { spawnError = error; });
  // port 0で起動し、Chromeがprofileに書くDevToolsActivePort (1行目port、2行目browser endpoint) から読む。
  let active = null;
  for (let i = 0; active == null && i < 80; i += 1) {
    if (spawnError != null) throw spawnError;
    try {
      const [port, path] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n");
      if (path?.startsWith("/devtools/browser/")) active = { port, path };
    } catch { /* まだ書かれていない */ }
    if (active == null) await sleep(250);
  }
  if (active == null) throw new Error("Chrome did not write DevToolsActivePort");
  const debugPort = active.port;
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browser = cdp(`ws://127.0.0.1:${debugPort}${active.path}`);
  await browser.opened;
  const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page");
  page = cdp(target.webSocketDebuggerUrl);
  await page.opened;
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
  await page.send("Page.bringToFront");
  await page.send("Page.navigate", { url });
  if (await waitFor(`typeof window.fleqRespondClockProbe === "function"`, 10_000) == null) throw new Error("main.js did not load");
  const { frameTree } = await page.send("Page.getFrameTree");
  isolatedContextId = (await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "fleq-smoke" })).executionContextId;

  await checkEnvironment(version.Browser.split("/")[1]);
  await checkConditionsHashes();
  await r38("noSnapshot");
  await checkStatusBeforeFirstSnapshot();
  const first = await publish(S43);
  await r38("VXSE43");
  await checkVxse43(first);
  await checkGeometryHash();
  await checkClockProbe();
  await checkMetadataOnly();
  await checkT01();
  await checkRemoval();
  await r38("VXSE45");
  await checkIntensityBounds();
  await checkCapacityExceeded();
  await checkNotices();
  await checkChannels();
  await checkConnectionAndWorker();
  await checkConfirmation();
  await checkSummary();
  await checkTimezones();
  await checkHtmlNotInterpreted();
  await checkHeartbeatOnlyStopped();
  const tickPhase = await checkStaleReconnect();
  if (tickPhase == null) record("P2-A9-T06:c:foregroundImmediate", "未確認", "-", { reason: "(b)で周期検査の位相を得られなかった" });
  else await checkForegroundImmediate(tickPhase);
  await checkMarkNamesOnly();
}

// A8 server.close の期限。超過したら Blocked を記録して先へ進み、残った接続は末尾の process.exit で解放する
// (A8 は http.Server を公開しないので、smoke から個々の接続を強制解放できない)。
async function closeServer(label) {
  const current = server;
  server = null;
  if (current == null) return;
  const closed = await Promise.race([current.close().then(() => true, () => true), sleep(5_000).then(() => false)]);
  if (!closed) record(`P2-A9-smoke:serverClose:${label}`, "Blocked", "-", { reason: "A8 server.close did not finish within 5 s" });
}

async function teardown() {
  try { await browser?.send("Browser.close", {}, 5_000); } catch { /* 下のpid指定killへ */ }
  browser?.close();
  page?.close();
  if (chrome?.pid != null && chrome.exitCode == null && chrome.signalCode == null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]) === false) {
      try { process.kill(chrome.pid, "SIGKILL"); } catch { /* 既に終了している */ }
    }
  }
  await closeServer("teardown");
  if (profileDir != null) rmSync(profileDir, { recursive: true, force: true });
}

let exitCode = 1;
try {
  await main();
} catch (error) {
  record("P2-A9-smoke:fatal", "Blocked", "-", { message: String(error?.stack ?? error) });
} finally {
  await teardown();
  const failed = results.filter((r) => r.status !== "Pass");
  writeFileSync(join(evidenceDir, "smoke-result.json"), `${JSON.stringify({
    schemaVersion: "p2-a9-chrome-smoke-evidence-v1", ranAt: new Date().toISOString(),
    conditions: { file: "reconstruction/test/eew-e01/evidence/chrome-smoke-conditions.json", conditionsSha256: conditions.conditionsSha256 },
    chrome: { executable: CHROME, flags: CHROME_FLAGS, headless: false,
      observer: "smoke側でnative EventSourceを透過subclassで包み、生成・close・受信時刻を記録 (製品コードは無変更)" },
    results,
    precedingEvidenceOnly: PRECEDING.map((item) => ({ ...item, status: "先行証拠のみ（Passと報告しない）" })),
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ total: results.length, notPass: failed.map((r) => `${r.id}=${r.status}`) })}\n`);
  exitCode = failed.length === 0 ? 0 : 1;
}
// 期限切れで残った接続・timer があっても、証拠を書いた後は必ず終える。
process.exit(exitCode);
