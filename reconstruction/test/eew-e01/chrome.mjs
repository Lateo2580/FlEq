// P2-A10-AC04/AC05/AC14: 前景の実 Chrome を CDP で操る。起動と後始末は A9 smoke（test/chrome-eew/smoke.mjs）に倣う。
// 無いと、T5/T6 の実 paint 証拠（trace）と Node/Chrome の時計往復が取れない。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// smoke と同じ flag。前景 tab のまま throttling させず、色を sRGB に固定する。
const FLAGS = ["--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--force-color-profile=srgb",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
// Phase 0 で確かめた最小 4 category。
const TRACE_CATEGORIES = ["blink.user_timing", "devtools.timeline", "disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.screenshot"];
const CDP_TIMEOUT_MS = 30_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hrMs = () => Number(process.hrtime.bigint()) / 1e6;

function cdp(url) {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  const pending = new Map();
  const listeners = new Map();
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
    if (message.id == null) { for (const f of listeners.get(message.method) ?? []) f(message.params); return; }
    const waiter = settle(message.id);
    if (message.error != null) waiter?.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`));
    else waiter?.resolve(message.result);
  });
  socket.on("error", () => {});
  socket.on("close", () => { for (const id of [...pending.keys()]) settle(id).reject(new Error("CDP socket closed")); });
  return {
    opened: new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }),
    close: () => socket.close(),
    on: (method, f) => listeners.set(method, [...(listeners.get(method) ?? []), f]),
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

export async function chromeVersion() {
  return await new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--version"]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(out.trim().replace(/^Google Chrome /, "")));
    child.on("error", reject);
  });
}

// url のページを 1440×900・DPR2 の前景 tab で開く。close() は正常・例外・SIGINT のどれでも呼ばれる前提で冪等。
export async function openPage(url) {
  const profile = mkdtempSync(join(tmpdir(), "fleq-a10-chrome-"));
  const chrome = spawn(CHROME, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, ...FLAGS, "about:blank"], { stdio: "ignore" });
  let spawnError = null;
  chrome.once("error", (error) => { spawnError = error; });
  let browser = null;
  let page = null;
  // smoke の teardown と同じ: Browser.close の後に exit を最大 5 秒待ち、残っていれば SIGKILL。2 回目以降の呼び出しも同じ後始末の完了を待つ。
  let closing = null;
  const close = () => (closing ??= (async () => {
    try { await browser?.send("Browser.close", {}, 5_000); } catch { /* pid 指定の kill へ */ }
    browser?.close();
    page?.close();
    if (chrome.pid != null && chrome.exitCode == null && chrome.signalCode == null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]) === false) {
        try { process.kill(chrome.pid, "SIGKILL"); } catch { /* 既に終了 */ }
      }
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  })());
  try {
    let active = null;
    for (let i = 0; active == null && i < 120; i++) {
      if (spawnError != null) throw spawnError;
      try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
        if (path?.startsWith("/devtools/browser/")) active = { port, path };
      } catch { /* まだ書かれていない */ }
      if (active == null) await sleep(250);
    }
    if (active == null) throw new Error("Chrome did not write DevToolsActivePort");
    browser = cdp(`ws://127.0.0.1:${active.port}${active.path}`);
    await browser.opened;
    const target = (await (await fetch(`http://127.0.0.1:${active.port}/json/list`)).json()).find((t) => t.type === "page");
    page = cdp(target.webSocketDebuggerUrl);
    await page.opened;
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.bringToFront");
    await page.send("Page.navigate", { url });
  } catch (error) {
    await close();
    throw error;
  }
  const evaluate = async (expression) => {
    const response = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails != null) throw new Error(`evaluate: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value;
  };
  return { evaluate, close, page };
}

// 1 回の往復。Node 側の送受信は hrtime（host launcher の clock 行と同じ系）で取り、Chrome 側は A9 の応答をそのまま使う。
async function probeOnce(evaluate, probeId) {
  const nodeSentHrMs = hrMs();
  const response = await evaluate(`window.fleqRespondClockProbe(${JSON.stringify(probeId)})`);
  const nodeReceivedHrMs = hrMs();
  return { probeId, nodeSentHrMs, nodeReceivedHrMs, chromeReceivedMonotonicMs: response.chromeReceivedMonotonicMs,
    chromeSentMonotonicMs: response.chromeSentMonotonicMs, roundTripWidthMs: (nodeReceivedHrMs - nodeSentHrMs) - (response.chromeSentMonotonicMs - response.chromeReceivedMonotonicMs) };
}

// 最大 3 回まで試して最も狭いものを採る。全試行を残す。
export async function probeClock(evaluate, probeId) {
  const attempts = [];
  for (let k = 0; k < 3; k++) {
    attempts.push(await probeOnce(evaluate, `${probeId}#${k}`));
    if (attempts[k].roundTripWidthMs <= 1) break;
  }
  const chosen = attempts.reduce((a, b) => (b.roundTripWidthMs < a.roundTripWidthMs ? b : a));
  return { probeId, atHrMs: chosen.nodeSentHrMs, chosen, attempts };
}

export async function startTracing(page) {
  const done = new Promise((resolve) => page.on("Tracing.tracingComplete", resolve));
  await page.send("Tracing.start", { transferMode: "ReturnAsStream", streamFormat: "json",
    traceConfig: { recordMode: "recordContinuously",
      // 予備測定の実測は 1 試行あたり約 45KB（正式）〜160KB（参考）。100 試行の区切りで最大 16MB に対し 4 倍の余裕を明示する（既定値に頼らない）。
      traceBufferSizeInKb: 64 * 1024, includedCategories: TRACE_CATEGORIES, excludedCategories: ["*"] } });
  return { done }; // Promise をそのまま返すと await が tracingComplete まで待ってしまう
}

// 戻り値の text は Chrome が出した trace の JSON 全文（run 記録の外に保存する）。
export async function stopTracing(page, { done }) {
  await page.send("Tracing.end");
  const { stream, dataLossOccurred } = await done;
  const chunks = [];
  for (;;) {
    const r = await page.send("IO.read", { handle: stream, size: 8 * 1024 * 1024 }, 60_000);
    chunks.push(r.base64Encoded ? Buffer.from(r.data, "base64") : Buffer.from(r.data));
    if (r.eof) break;
  }
  await page.send("IO.close", { handle: stream });
  return { text: Buffer.concat(chunks), dataLossOccurred: dataLossOccurred === true };
}
