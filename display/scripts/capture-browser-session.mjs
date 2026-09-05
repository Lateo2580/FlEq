import { spawn } from "node:child_process";
import { join } from "node:path";

export const CAPTURE_TIMEOUT_MS = 120_000;
export const CAPTURE_SCHEMA_VERSION = 2;
export const CAPTURE_PROCESS_STRATEGY = "one-browser-per-capture";
export const SCREENSHOT_PARAMS = Object.freeze({ format: "png", fromSurface: true, captureBeyondViewport: false });

export class CaptureAssertionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CaptureAssertionError";
    this.code = code;
  }
}

export function canonicalJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical-json-v1 forbids non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) throw new Error("canonical-json-v1 forbids sparse arrays");
    return canonicalJsonValue(value[index]);
  });
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalJsonValue(value[key]);
    return result;
  }
  throw new Error(`canonical-json-v1 forbids ${typeof value}`);
}

export function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function deviceMetricsOverrideFor(viewportMode, requestedViewport) {
  if (viewportMode === "legacy-control") return null;
  if (viewportMode !== "calibrated") throw new Error(`unknown viewport mode: ${viewportMode}`);
  return { width: requestedViewport.width, height: requestedViewport.height, deviceScaleFactor: 1, mobile: false };
}

export function captureRouteProfile({ requestedViewport, virtualTimeBudgetMs }) {
  if (virtualTimeBudgetMs !== null && virtualTimeBudgetMs !== 10_000) throw new Error("virtualTimeBudgetMs must be 10000 or null");
  return {
    headless: "new",
    noSandbox: true,
    noFirstRun: true,
    disableGpu: true,
    hideScrollbars: true,
    forcedDeviceScaleFactor: 1,
    requestedWindowSize: { width: requestedViewport.width, height: requestedViewport.height },
    virtualTimeBudgetMs,
  };
}

export function buildChromeLaunchArgs({ profileDir, url, requestedViewport, virtualTimeBudgetMs }) {
  const args = [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--remote-debugging-pipe", `--user-data-dir=${profileDir}`, `--window-size=${requestedViewport.width},${requestedViewport.height}`,
  ];
  // Keep the capture URL out of Chrome's startup navigation. The capture
  // session attaches to this blank page, pauses virtual time, and only then
  // navigates. That preserves the legacy budget's start coordinate without
  // Headless's one-shot budget-expiry shutdown invalidating the CDP session.
  void url;
  void virtualTimeBudgetMs;
  args.push("about:blank");
  return args;
}

export function virtualTimePolicyFor(virtualTimeBudgetMs) {
  return virtualTimeBudgetMs == null ? null : {
    policy: "pauseIfNetworkFetchesPending",
    budget: virtualTimeBudgetMs,
    maxVirtualTimeTaskStarvationCount: 10_000,
  };
}

export const VIRTUAL_TIME_PAUSE_POLICY = Object.freeze({ policy: "pause" });

export function browserMetadata(requestedBinary, version) {
  const required = ["protocolVersion", "product", "revision", "userAgent", "jsVersion"];
  for (const field of required) {
    if (typeof version?.[field] !== "string" || version[field] === "") throw new Error(`Browser.getVersion missing ${field}`);
  }
  return { requestedBinary, ...Object.fromEntries(required.map((field) => [field, version[field]])) };
}

export const DOCUMENT_CAPTURE_EXPRESSION = String.raw`(async () => {
  await (document.fonts?.ready ?? Promise.resolve());
  const preview = document.querySelector('main.preview-screen');
  const standby = document.querySelector('.standby');
  const measure = (node) => node == null ? null : (() => {
    const rect = node.getBoundingClientRect();
    return { clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, width: rect.width, height: rect.height };
  })();
  const overlap = (left, right) => {
    if (left == null || right == null) return 0;
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  };
  const panels = [...document.querySelectorAll('.tsunami-panel, .quake-panel')]
    .filter((panel) => panel.clientWidth > 0 && panel.clientHeight > 0)
    .map((panel) => {
      const livePage = panel.querySelector('.page-fade');
      const body = livePage?.querySelector('.page-body, .page-list-body') ?? null;
      const probePage = panel.querySelector('[data-partition-probe-geometry="true"]');
      const probeBody = probePage?.querySelector('.partition-probe-body') ?? null;
      const chrome = livePage?.querySelector('.page-frame, .page-header') ?? null;
      const probeChrome = probePage?.querySelector('.page-frame, .page-header') ?? null;
      return {
        kind: panel.classList.contains('tsunami-panel') ? 'tsunami' : 'quake',
        panel: measure(panel), body: measure(body), probeBody: measure(probeBody), chrome: measure(chrome), probeChrome: measure(probeChrome),
        indicatorBodyOverlap: overlap(livePage?.querySelector('.page-dots') ?? null, body),
      };
    });
  const contained = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0 && box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
  const emergencyGeometryValid = panels.length >= 2 && panels.every((entry) => contained(entry.panel) && contained(entry.body)
    && entry.indicatorBodyOverlap <= 0 && (entry.kind !== 'tsunami' || (contained(entry.probeBody) && entry.probeChrome != null && entry.chrome != null
      && entry.probeChrome.clientWidth > 0 && entry.probeChrome.clientHeight > 0 && Math.abs(entry.probeChrome.height - entry.chrome.height) <= 1
      && Math.abs(entry.probeBody.width - entry.body.width) <= 1)));
  const doctype = document.doctype == null ? '' : new XMLSerializer().serializeToString(document.doctype) + '\n';
  const stableRoot = document.documentElement.cloneNode(true);
  for (const clock of stableRoot.querySelectorAll('.clock, .ticker-clock')) {
    const text = document.createTreeWalker(clock, window.NodeFilter.SHOW_TEXT);
    while (text.nextNode()) text.currentNode.nodeValue = '<capture-clock>';
  }
  return {
    fontsLoaded: document.fonts?.status === 'loaded',
    standbyPresent: standby != null,
    previewPresent: preview != null,
    measurementSettled: standby?.getAttribute('data-measurement-settled') === 'true',
    previewMode: document.querySelector('[data-preview-mode]')?.getAttribute('data-preview-mode') ?? null,
    attentionVisible: document.querySelector('[data-preview-attention-visibility]')?.getAttribute('data-preview-attention-visibility') === 'true',
    emergencyPanelCount: panels.length,
    emergencyGeometryValid,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    dom: doctype + document.documentElement.outerHTML,
    stableDom: doctype + stableRoot.outerHTML,
  };
})()`;

export function readinessFor(documentState, readinessKind) {
  if (readinessKind === "standby") {
    return {
      kind: "standby",
      fontsLoaded: documentState?.fontsLoaded === true,
      measurementSettled: documentState?.measurementSettled === true,
      stableSampleCount: 2,
    };
  }
  if (readinessKind === "emergency") {
    return {
      kind: "emergency",
      fontsLoaded: documentState?.fontsLoaded === true,
      measurementSettled: null,
      stableSampleCount: 2,
    };
  }
  throw new Error(`unknown readiness kind: ${readinessKind}`);
}

export function isReadinessSatisfied(documentState, readinessKind) {
  if (documentState?.fontsLoaded !== true || documentState.previewPresent !== true) return false;
  if (readinessKind === "standby") return documentState.standbyPresent === true && documentState.measurementSettled === true;
  if (readinessKind === "emergency") return documentState.previewMode === "emergency" && documentState.attentionVisible === true
    && documentState.emergencyPanelCount >= 2 && documentState.emergencyGeometryValid === true;
  throw new Error(`unknown readiness kind: ${readinessKind}`);
}

export function assertViewportContract(viewportMode, requestedViewport, measuredViewport) {
  if (![measuredViewport?.innerWidth, measuredViewport?.innerHeight, measuredViewport?.devicePixelRatio].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`invalid measured viewport: ${JSON.stringify(measuredViewport)}`);
  }
  if (measuredViewport.devicePixelRatio !== 1) throw new Error(`devicePixelRatio mismatch: ${measuredViewport.devicePixelRatio}`);
  if (viewportMode === "calibrated" && (measuredViewport.innerWidth !== requestedViewport.width || measuredViewport.innerHeight !== requestedViewport.height)) {
    throw new Error(`calibrated viewport mismatch: expected ${requestedViewport.width}x${requestedViewport.height}, got ${measuredViewport.innerWidth}x${measuredViewport.innerHeight}`);
  }
  if (viewportMode !== "calibrated" && viewportMode !== "legacy-control") throw new Error(`unknown viewport mode: ${viewportMode}`);
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function sanitizeCdpTrace(value, key = "") {
  if (typeof value === "string") {
    if (key === "expression") return `<expression:${value.length}>`;
    if (key === "data") return `<data:${value.length}>`;
    if (key === "dom") return `<dom:${value.length}>`;
    return value.length > 512 ? `${value.slice(0, 256)}…<${value.length}>` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeCdpTrace(entry));
  if (value != null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, sanitizeCdpTrace(entry, entryKey)]));
  return value;
}

export function formatCdpTraceMessage(direction, message) {
  return `[capture-cdp] ${direction} ${JSON.stringify(sanitizeCdpTrace(message))}`;
}

function writeCdpTrace(direction, message) {
  if (process.env.CAPTURE_CDP_TRACE === "1") process.stderr.write(`${formatCdpTraceMessage(direction, message)}\n`);
}

export function createCdpPipe(child) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (input == null || output == null) throw new Error("Chrome remote-debugging-pipe was not opened");
  let nextId = 1;
  let buffer = "";
  let terminalError = null;
  const pending = new Map();
  const eventWaiters = new Map();
  const rejectPending = (error) => {
    if (terminalError == null) terminalError = error;
    for (const request of pending.values()) request.reject(terminalError);
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const waiter of waiters) waiter.reject(terminalError);
    }
    eventWaiters.clear();
  };
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    try {
      buffer += chunk;
      let boundary = buffer.indexOf("\0");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (raw !== "") {
          const message = JSON.parse(raw);
          writeCdpTrace("recv", message);
          const request = pending.get(message.id);
          if (request != null) {
            pending.delete(message.id);
            if (message.error != null) request.reject(new Error(`${request.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
            else request.resolve(message.result);
          }
          if (typeof message.method === "string") {
            const waiters = eventWaiters.get(message.method) ?? [];
            const remaining = [];
            for (const waiter of waiters) {
              if (waiter.sessionId == null || waiter.sessionId === message.sessionId) waiter.resolve(message.params ?? {});
              else remaining.push(waiter);
            }
            if (remaining.length === 0) eventWaiters.delete(message.method);
            else eventWaiters.set(message.method, remaining);
          }
        }
        boundary = buffer.indexOf("\0");
      }
    } catch (error) {
      rejectPending(error instanceof Error ? error : new Error(String(error)));
    }
  });
  input.on("error", rejectPending);
  output.on("error", rejectPending);
  output.on("end", () => rejectPending(new Error("Chrome remote-debugging-pipe ended")));
  output.on("close", () => rejectPending(new Error("Chrome remote-debugging-pipe closed")));
  child.on("error", rejectPending);
  child.on("exit", (code, signal) => rejectPending(new Error(`Chrome exited while CDP was active: code=${code ?? "null"} signal=${signal ?? "null"}`)));
  child.on("close", (code, signal) => rejectPending(new Error(`Chrome closed while CDP was active: code=${code ?? "null"} signal=${signal ?? "null"}`)));
  return {
    command(method, params = {}, sessionId = undefined) {
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        if (terminalError != null) return rejectCommand(terminalError);
        pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand });
        const message = { id, method, params, ...(sessionId == null ? {} : { sessionId }) };
        writeCdpTrace("send", message);
        input.write(`${JSON.stringify(message)}\0`, (error) => {
          if (error != null) rejectPending(error);
        });
      });
    },
    waitForEvent(method, sessionId = undefined) {
      return new Promise((resolveEvent, rejectEvent) => {
        if (terminalError != null) return rejectEvent(terminalError);
        const waiters = eventWaiters.get(method) ?? [];
        waiters.push({ sessionId, resolve: resolveEvent, reject: rejectEvent });
        eventWaiters.set(method, waiters);
      });
    },
    close(error = new Error("Chrome remote-debugging-pipe closed")) { rejectPending(error); },
  };
}

export async function attachCaptureTarget({ cdp, targetId, url, requestedViewport, viewportMode, virtualTimeBudgetMs }) {
  // Direct attachment owns exactly one flat session. Auto-attach is not
  // enabled: disabling it later can detach auto-attached sessions, and workers
  // or iframes are not capture targets.
  const attached = await cdp.command("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("Target.attachToTarget did not return a sessionId");
  await cdp.command("Page.enable", {}, sessionId);
  await cdp.command("Runtime.enable", {}, sessionId);
  const deviceMetricsOverride = deviceMetricsOverrideFor(viewportMode, requestedViewport);
  if (deviceMetricsOverride != null) await cdp.command("Emulation.setDeviceMetricsOverride", deviceMetricsOverride, sessionId);
  const virtualTimePolicy = virtualTimePolicyFor(virtualTimeBudgetMs);
  if (virtualTimePolicy != null) await cdp.command("Emulation.setVirtualTimePolicy", VIRTUAL_TIME_PAUSE_POLICY, sessionId);
  const navigation = await cdp.command("Page.navigate", { url }, sessionId);
  if (navigation?.errorText != null && navigation.errorText !== "") throw new Error(`Page.navigate: ${navigation.errorText}`);
  if (virtualTimePolicy != null) {
    const budgetExpired = cdp.waitForEvent("Emulation.virtualTimeBudgetExpired", sessionId);
    await Promise.all([cdp.command("Emulation.setVirtualTimePolicy", virtualTimePolicy, sessionId), budgetExpired]);
  }
  return { sessionId, deviceMetricsOverride };
}

export function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let timer = null;
    const cleanup = () => {
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      if (timer != null) clearTimeout(timer);
    };
    const onExit = () => { cleanup(); resolveExit(true); };
    child.once("exit", onExit);
    child.once("close", onExit);
    timer = setTimeout(() => { cleanup(); resolveExit(false); }, timeoutMs);
  });
}

export async function terminateChild(child, { graceMs = 1_000, killWaitMs = 1_000 } = {}) {
  if (child.exitCode != null || child.signalCode != null) return "already-exited";
  const gracefulExit = waitForChildExit(child, graceMs);
  child.kill("SIGTERM");
  if (await gracefulExit) return "sigterm";
  const forcedExit = waitForChildExit(child, killWaitMs);
  child.kill("SIGKILL");
  if (await forcedExit) return "sigkill";
  for (const stream of child.stdio ?? []) stream?.destroy?.();
  child.unref?.();
  throw new Error("Chrome did not exit after SIGKILL");
}

export async function executeCaptureProtocol({
  cdp, url, requestedViewport, viewportMode, readinessKind, virtualTimeBudgetMs, collectSnapshot, label,
  initialDelayMs, sampleDelayMs, maxSamples, stableProjection, waitFor = wait,
}) {
  let page = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await cdp.command("Target.getTargets");
    page = targets.targetInfos.find((candidate) => candidate.type === "page" && candidate.url === "about:blank")
      ?? targets.targetInfos.find((candidate) => candidate.type === "page") ?? null;
    if (page != null) break;
    await waitFor(100);
  }
  if (page == null) throw new Error(`${label}: page target did not become ready`);
  const attached = await attachCaptureTarget({ cdp, targetId: page.targetId, url, requestedViewport, viewportMode, virtualTimeBudgetMs });
  const version = await cdp.command("Browser.getVersion");
  const evaluate = async (expression) => {
    const result = await cdp.command("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression }, attached.sessionId);
    if (result.exceptionDetails != null) throw new Error(`${label}: browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  await waitFor(initialDelayMs);
  let previous = null;
  let stable = null;
  for (let attempt = 0; attempt < maxSamples; attempt += 1) {
    const candidate = await collectSnapshot({ evaluate });
    const serialized = canonicalJsonStringify(stableProjection(candidate));
    if (isReadinessSatisfied(candidate.document, readinessKind) && previous?.serialized === serialized) {
      stable = [previous.value, candidate];
      break;
    }
    previous = isReadinessSatisfied(candidate.document, readinessKind) ? { serialized, value: candidate } : null;
    await waitFor(sampleDelayMs);
  }
  if (stable == null) throw new Error(`${label}: ${readinessKind} readiness did not settle`);
  assertViewportContract(viewportMode, requestedViewport, stable[1].document.viewport);
  const screenshot = await cdp.command("Page.captureScreenshot", SCREENSHOT_PARAMS, attached.sessionId);
  const postScreenshot = await collectSnapshot({ evaluate });
  if (canonicalJsonStringify(stableProjection(postScreenshot)) !== canonicalJsonStringify(stableProjection(stable[1]))) throw new Error(`${label}: DOM state changed while capturing screenshot`);
  return { version, stable, preScreenshot: stable[1], postScreenshot, screenshotData: screenshot.data };
}

export async function runCaptureBrowserSession({
  chrome, profileDir, url, requestedViewport, viewportMode, readinessKind, virtualTimeBudgetMs, sessionRole,
  collectSnapshot, label = "capture", spawnBrowser = spawn, timeoutMs = CAPTURE_TIMEOUT_MS,
  initialDelayMs = 750, sampleDelayMs = 400, maxSamples = 30, stableProjection = (value) => value,
  protocolRunner = executeCaptureProtocol, terminationGraceMs = 1_000, terminationKillWaitMs = 1_000,
}) {
  const browserProfile = join(profileDir, `.capture-${sessionRole}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const commonLaunchProfile = captureRouteProfile({ requestedViewport, virtualTimeBudgetMs });
  const deviceMetricsOverride = deviceMetricsOverrideFor(viewportMode, requestedViewport);
  const child = spawnBrowser(chrome, buildChromeLaunchArgs({ profileDir: browserProfile, url, requestedViewport, virtualTimeBudgetMs }), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  if (process.env.CAPTURE_CDP_TRACE === "1") {
    writeCdpTrace("lifecycle", { event: "spawn", pid: child.pid ?? null, label, url, strategy: CAPTURE_PROCESS_STRATEGY });
    child.on("exit", (code, signal) => writeCdpTrace("lifecycle", { event: "exit", pid: child.pid ?? null, label, code, signal }));
    child.on("close", (code, signal) => writeCdpTrace("lifecycle", { event: "close", pid: child.pid ?? null, label, code, signal }));
  }
  const cdp = createCdpPipe(child);
  let deadlineTimer = null;
  let timedOut = false;
  const timeoutError = new Error(`${label}: capture timed out after ${timeoutMs}ms`);
  const operation = (async () => {
    try {
      const result = await protocolRunner({
        cdp, url, requestedViewport, viewportMode, readinessKind, virtualTimeBudgetMs, collectSnapshot, label,
        initialDelayMs, sampleDelayMs, maxSamples, stableProjection,
      });
      return {
        browser: browserMetadata(chrome, result.version),
        capture: { viewportMode, deviceMetricsOverride, readinessKind, virtualTimeBudgetMs, sessionRole, commonLaunchProfile },
        stable: result.stable, preScreenshot: result.preScreenshot, postScreenshot: result.postScreenshot, screenshotData: result.screenshotData,
      };
    } finally {
      cdp.close(timedOut ? timeoutError : undefined);
      if (!timedOut) await terminateChild(child, { graceMs: terminationGraceMs, killWaitMs: terminationKillWaitMs });
    }
  })();
  const deadline = new Promise((_, rejectDeadline) => {
    deadlineTimer = setTimeout(async () => {
      timedOut = true;
      cdp.close(timeoutError);
      const forcedExit = waitForChildExit(child, terminationKillWaitMs);
      child.kill("SIGKILL");
      if (!await forcedExit) {
        for (const stream of child.stdio ?? []) stream?.destroy?.();
        child.unref?.();
      }
      rejectDeadline(timeoutError);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, deadline]);
    if (timedOut) throw timeoutError;
    return result;
  } finally {
    if (deadlineTimer != null) clearTimeout(deadlineTimer);
  }
}
