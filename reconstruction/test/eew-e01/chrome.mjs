// P2-A10-AC04/AC05/AC14: 前景の実 Chrome を CDP で操る。起動と後始末は A9 smoke（test/chrome-eew/smoke.mjs）に倣う。
// 無いと、T5/T6 の実 paint 証拠（trace）と Node/Chrome の時計往復が取れない。
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// smoke と同じ flag。前景 tab のまま throttling させず、色を sRGB に固定する。
export const FLAGS = ["--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--force-color-profile=srgb",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
// Phase 0 で確かめた最小 4 category。
const TRACE_CATEGORIES = ["blink.user_timing", "devtools.timeline", "disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.screenshot"];
const CDP_TIMEOUT_MS = 30_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hrMs = () => Number(process.hrtime.bigint()) / 1e6;

function cdp(url) {
  // handshakeTimeout: Upgrade の応答が来ないと opened が解決せず、command の期限（CDP_TIMEOUT_MS）も効かない（P3-PH-AC02 の品質レビュー P2-2）。
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024, handshakeTimeout: CDP_TIMEOUT_MS });
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
    connecting: () => socket.readyState === WebSocket.CONNECTING,
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

// cdp（"<host>:<port>"）を渡すと spawn せず、その入口の Chrome の Browser（"Chrome/<版>"）から手元と同じ形の版を返す（P3-PH-AC02 (1)）。
export async function chromeVersion(cdp = null) {
  if (cdp != null) return (await (await fetch(`http://${cdp}/json/version`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) })).json()).Browser.replace(/^Chrome\//, "");
  return await new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--version"]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(out.trim().replace(/^Google Chrome /, "")));
    child.on("error", reject);
  });
}

// 手元に新しい profile で Chrome を起こし、DevToolsActivePort を待って browser の CDP につなぐ（openPage の手元と chrome-remote.mjs、P3-PH-AC03）。
// close() は冪等。scope（run.mjs の窓の後始末リスト）を渡すと、spawn の直後に close と孤児確認を登録する（起動待ちの間に窓が期限切れになっても Chrome を止める）。
export async function launchChrome(scope = null) {
  const profile = mkdtempSync(join(tmpdir(), "fleq-a10-chrome-"));
  const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, ...FLAGS, "about:blank"];
  const chrome = spawn(CHROME, args, { stdio: "ignore" });
  let spawnError = null;
  chrome.once("error", (error) => { spawnError = error; });
  let browser = null;
  // smoke の teardown と同じ: Browser.close の後に exit を最大 5 秒待ち、残っていれば SIGKILL。2 回目以降の呼び出しも同じ後始末の完了を待つ。
  let closing = null;
  const close = () => (closing ??= (async () => {
    try { await browser?.send("Browser.close", {}, 5_000); } catch { /* pid 指定の kill へ */ }
    browser?.close();
    if (chrome.pid != null && chrome.exitCode == null && chrome.signalCode == null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]) === false) {
        try { process.kill(chrome.pid, "SIGKILL"); } catch { /* 既に終了 */ }
      }
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  })());
  scope?.add(close);
  scope?.children.push({ name: "chrome", pid: chrome.pid, alive: () => spawnError == null && chrome.exitCode == null && chrome.signalCode == null, kill: () => chrome.kill("SIGKILL") });
  let active = null;
  try {
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
  } catch (error) {
    await close();
    throw error;
  }
  return { chrome, browser, port: active.port, command: [CHROME, ...args].join(" "), close };
}

// 遠隔の Chrome の起動の flag を確かめ（無いと throttling を止める flag なしで起動されていても気づかない）、記録する値を返す（P3-PH-AC02 (3)）。
async function remoteInfo(browser, endpoint, live) {
  const info = await browser.send("SystemInfo.getInfo");
  live();
  const version = await browser.send("Browser.getVersion");
  live();
  const words = String(info.commandLine ?? "").split(" ");
  const missing = [...FLAGS, "--remote-debugging-port"].filter((flag) => !words.some((w) => w === flag || w.startsWith(`${flag}=`)));
  if (missing.length > 0) throw new Error(`remote Chrome at ${endpoint} was started without ${missing.join(" ")}`);
  return { cdp: endpoint, product: version.product, userAgent: version.userAgent, modelName: info.modelName, modelVersion: info.modelVersion };
}

// url のページを 1440×900・DPR2 の前景 tab で開く。close() は正常・例外・SIGINT のどれでも呼ばれる前提で冪等。
// motion を渡すと prefers-reduced-motion をその値に固定する（OS の設定で変わらないように。試行の前の確認は run.mjs）。
// cdp（"<host>:<port>"、chrome-remote.mjs の --listen）を渡すと手元に spawn せず、その Chrome に窓ごとの新しい browser context で page を開く
// （手元の「窓ごとに新しい profile」の代わり。無いと前の窓の保存や cache が次の窓に残る）。close は page と context だけを閉じ、Chrome の
// process は止めない（Mac mini の道具が持つ）。scope.children には登録しない（孤児の確認の kill の相手が Pi に無い）。P3-PH-AC02 (2)。
export async function openPage(url, scope = null, { motion = null, cdp: endpoint = null } = {}) {
  let launched = null;
  let browser = null;
  let page = null;
  let remote = null;
  let context = null; // 遠隔の { browserContextId, targetId }
  // 開く途中に close（SIGINT の後始末）が来たら、待ちを中断し、開く処理が終わってから、その後に取れた context・page も回収する
  // （無いと、止めた後に届いた返信から作った context・page が破棄されずに残る。品質レビュー P2-1）。
  let stopped = false;
  const abort = new AbortController();
  const live = () => { if (stopped) throw new Error("openPage was closed while opening"); };
  // 返信の後ごとに止めた印を見る（止めた後に待つのは返信待ちの 1 command だけにする。無いと残りの初期化の待ちが host の停止の前に積み重なる）。
  const step = async (sent) => { const result = await sent; live(); return result; };
  const release = async () => {
    const [b, c, p, l] = [browser, context, page, launched];
    context = null;
    if (c?.targetId != null) { try { await b.send("Target.closeTarget", { targetId: c.targetId }, 5_000); } catch { /* context の破棄で閉じる */ } }
    if (c != null) { try { await b.send("Target.disposeBrowserContext", { browserContextId: c.browserContextId }, 5_000); } catch { /* Chrome 側の後始末は道具の終了で */ } }
    p?.close();
    if (l != null) await l.close();
    else b?.close();
  };
  let opening = null;
  let closing = null;
  const close = () => (closing ??= (async () => {
    stopped = true;
    abort.abort();
    // 接続の確立待ちは切る（返信を待つ command は期限まで待ち、取れた資源を release で回収する）。
    for (const c of [browser, page]) if (c?.connecting()) c.close();
    await opening;
    await release();
  })());
  opening = (async () => {
    try {
      if (endpoint == null) {
        launched = await launchChrome(scope);
        browser = launched.browser;
        const target = (await (await fetch(`http://127.0.0.1:${launched.port}/json/list`)).json()).find((t) => t.type === "page");
        page = cdp(target.webSocketDebuggerUrl);
      } else {
        scope?.add(close);
        // 返る URL の host は転送の道具を通ると当てにできないので、path だけを使う。本文の読み終わりまでを総期限に入れる。
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(CDP_TIMEOUT_MS)]);
        const { webSocketDebuggerUrl } = await (await fetch(`http://${endpoint}/json/version`, { signal })).json();
        live();
        browser = cdp(`ws://${endpoint}${new URL(webSocketDebuggerUrl).pathname}`);
        await browser.opened;
        live();
        remote = await remoteInfo(browser, endpoint, live);
        context = { browserContextId: (await browser.send("Target.createBrowserContext")).browserContextId, targetId: null };
        live();
        context.targetId = (await browser.send("Target.createTarget", { url: "about:blank", browserContextId: context.browserContextId })).targetId;
        live();
        page = cdp(`ws://${endpoint}/devtools/page/${context.targetId}`);
      }
      await page.opened;
      live();
      await step(page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }));
      await step(page.send("Page.enable"));
      await step(page.send("Runtime.enable"));
      if (motion != null) await step(page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: motion === "reduced" ? "reduce" : "no-preference" }] }));
      await step(page.send("Page.navigate", { url }));
      // navigate の後に前面化する（2026-10-27 夜の決め。前では全試行 hasFocus false だった候補、効いたかは窓の記録の hasFocus で見る）。
      await step(page.send("Page.bringToFront"));
      return null;
    } catch (error) {
      return error;
    }
  })();
  const failure = await opening;
  if (failure != null) {
    await close();
    throw failure;
  }
  const evaluate = async (expression) => {
    const response = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails != null) throw new Error(`evaluate: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value;
  };
  return { evaluate, close, page, remote, command: launched == null ? `remote cdp=${endpoint}` : launched.command,
    activation: launched == null ? "remote" : await activate(launched.chrome.pid) };
}

// 起動した Chrome の process を OS の前面（key window）にする（P3-C4 工程2d、W5 で runner の Chrome が key window でなく全試行が
// hasFocus false だった）。macOS だけで、System Events の操作の許可が要る。失敗しても止めず、結果を返して run-record に残す
// （hasFocus は記録だけで成立を止めない、run.mjs の trialConditionDeviation）。
export function activate(pid) {
  if (process.platform !== "darwin" || pid == null) return Promise.resolve("notApplicable");
  const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`;
  return new Promise((done) => execFile("osascript", ["-e", script], { timeout: 5_000 },
    (error) => done(error == null ? "activated" : `failed: ${String(error.message).split("\n")[0]}`)));
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
