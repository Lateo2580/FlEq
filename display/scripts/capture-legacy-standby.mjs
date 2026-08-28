#!/usr/bin/env node
/**
 * Capture real StandbyScreen layout-gate renders after its measurement epoch settles.
 *
 * Usage:
 *   node scripts/capture-legacy-standby.mjs
 *   CHROME_BIN=chrome node scripts/capture-legacy-standby.mjs --scenario 4 --viewport 1920x1080
 *   node scripts/capture-legacy-standby.mjs --url http://127.0.0.1:5199/preview.html
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DISPLAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(DISPLAY_DIR, "dist");
const DEFAULT_SCENARIOS = ["quiet", "4", "7", "max", "max-floodWide"];
const SUPPORTED_SCENARIOS = [...DEFAULT_SCENARIOS];
const DEFAULT_VIEWPORTS = ["1920x1080", "1512x982", "1280x720", "960x620"];
const FLOOD_WIDE_VIEWPORTS = ["1920x1080", "1280x720"];
const BRIEFING_PAGING_PAGE_COUNT = 3;
const ATTENTION_VISIBILITY_FIXTURES = new Set(["attention-visibility-standby", "attention-visibility-emergency", "attention-visibility-reduced-motion"]);
const MIME_TYPES = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"],
  [".map", "application/json"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"],
]);

function usage(message) {
  if (message != null) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/capture-legacy-standby.mjs [--report] [--fixture overflow|overlap|rotation|cluster|cluster-calm|tornado-pages|tornado-aggregate|tornado-clip|tornado-epoch-release|recent-quakes-narrow|attention-visibility-standby|attention-visibility-emergency|attention-visibility-reduced-motion|briefing-pages|briefing-single-page] [--url URL] [--scenario quiet|4|7|max|max-floodWide] [--viewport WIDTHxHEIGHT] [--out-dir PATH]\n");
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { url: null, scenarios: [], viewports: [], outDir: null, report: false, fixture: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--url" || argument === "--scenario" || argument === "--viewport" || argument === "--out-dir" || argument === "--fixture") {
      if (value == null) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--url") result.url = value;
      if (argument === "--scenario") result.scenarios.push(value);
      if (argument === "--viewport") result.viewports.push(value);
      if (argument === "--out-dir") result.outDir = value;
      if (argument === "--fixture") result.fixture = value;
      continue;
    }
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--report") { result.report = true; continue; }
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match == null) throw new Error(`invalid viewport: ${value}`);
  return { label: value, width: Number(match[1]), height: Number(match[2]) };
}

function run(command, args, stdoutFd = null, watchPath = null) {
  return new Promise((resolveRun, rejectRun) => {
    // macOS Chrome can abort when its headless output is connected to a pipe.
    // Dump DOM to a regular file instead, keeping the browser process isolated.
    const child = spawn(command, args, { stdio: ["ignore", stdoutFd ?? "ignore", "ignore"] });
    // The gate page keeps timers running, so headless Chrome never exits on
    // its own after writing the artifact. Only a non-empty artifact whose
    // size stays unchanged across consecutive polls may satisfy the watchdog.
    let watchdogKilled = false;
    let timedOut = false;
    let pollTimer = null;
    let previousSize = -1;
    let stablePolls = 0;
    const deadlineTimer = watchPath == null ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    if (watchPath != null) {
      pollTimer = setInterval(() => {
        stat(watchPath).then((info) => {
          if (info.size === 0) { previousSize = 0; stablePolls = 0; return; }
          stablePolls = info.size === previousSize ? stablePolls + 1 : 0;
          previousSize = info.size;
          if (stablePolls < 3) return;
          clearInterval(pollTimer);
          watchdogKilled = child.kill("SIGTERM");
        }, () => {});
      }, 250);
    }
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (pollTimer != null) clearInterval(pollTimer);
      if (deadlineTimer != null) clearTimeout(deadlineTimer);
      // The deadline outranks the watchdog: a SIGTERM that never took effect
      // must not read as success just because the artifact once looked stable.
      if (timedOut) rejectRun(new Error(`${command} timed out ${code ?? signal ?? "unknown"}`));
      else if (code === 0 || watchdogKilled) resolveRun();
      else rejectRun(new Error(`${command} exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function startStaticServer() {
  await stat(join(DIST_DIR, "preview.html"));
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relativePath = requestPath === "/" ? "preview.html" : requestPath.replace(/^\//, "");
    const pathname = normalize(relativePath);
    const filename = join(DIST_DIR, pathname);
    if (pathname.startsWith("..") || !filename.startsWith(`${DIST_DIR}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const contents = await readFile(filename);
      response.writeHead(200, { "content-type": MIME_TYPES.get(extname(filename)) ?? "application/octet-stream" }).end(contents);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("static server did not return a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/preview.html`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error == null ? resolveClose() : rejectClose(error))),
  };
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function createCdpPipe(child) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (input == null || output == null) throw new Error("Chrome remote-debugging-pipe was not opened");
  let nextId = 1;
  let buffer = "";
  let terminalError = null;
  const pending = new Map();
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\0");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (raw !== "") {
        const message = JSON.parse(raw);
        const request = pending.get(message.id);
        if (request != null) {
          pending.delete(message.id);
          if (message.error != null) request.reject(new Error(`${request.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
          else request.resolve(message.result);
        }
      }
      boundary = buffer.indexOf("\0");
    }
  });
  const rejectPending = (error) => {
    terminalError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  output.on("error", rejectPending);
  child.on("error", rejectPending);
  return {
    command(method, params = {}, sessionId = undefined) {
      const id = nextId++;
      return new Promise((resolveCommand, rejectCommand) => {
        if (terminalError != null) {
          rejectCommand(terminalError);
          return;
        }
        pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand });
        input.write(`${JSON.stringify({ id, method, params, ...(sessionId == null ? {} : { sessionId }) })}\0`);
      });
    },
    close() { rejectPending(new Error("Chrome remote-debugging-pipe closed")); },
  };
}

async function captureLiveGeometry({ chrome, profileDir, url, viewport }) {
  const geometryProfile = join(profileDir, `.geometry-${Date.now()}`);
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--remote-debugging-pipe", `--user-data-dir=${geometryProfile}`, `--window-size=${viewport.width},${viewport.height}`, url,
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = createCdpPipe(child);
  try {
    let page = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const targets = await cdp.command("Target.getTargets");
        page = targets.targetInfos.find((candidate) => candidate.type === "page" && candidate.url === url)
          ?? targets.targetInfos.find((candidate) => candidate.type === "page")
          ?? null;
      } catch {
        // Chrome has not opened its first page target yet.
      }
      if (page != null) break;
      await wait(100);
    }
    if (page == null) throw new Error("Chrome DevTools page target did not become ready");
    const attached = await cdp.command("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await wait(500);
    // Panels animate on entry (height reveal) and re-partition on fonts.ready.
    // A single early sample reads a mid-animation body as a containment
    // violation, so wait for the web font and require two identical
    // consecutive samples before trusting the geometry.
    const evaluateGeometry = () => cdp.command("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        await (document.fonts?.ready ?? Promise.resolve());
        const pick = (selector) => [...document.querySelectorAll(selector)]
          .filter((node) => node.clientWidth > 0 && node.clientHeight > 0)
          .sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0] ?? null;
        const measure = (node) => node == null ? null : (() => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const chain = [];
          for (let parent = node.parentElement, depth = 0; parent != null && depth < 5; parent = parent.parentElement, depth += 1) chain.push(parent.className.split(" ").slice(0, 2).join("."));
          return {
            clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
            verticalBorderPx: (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0),
            width: rect.width, height: rect.height, maxHeight: style.maxHeight, cls: node.className, chain,
            hiddenAncestor: node.closest('[aria-hidden="true"], [hidden], [inert]') != null,
          };
        })();
        const styled = (node, properties) => node == null ? null : (() => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            ...Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)])),
          };
        })();
        const overlap = (left, right) => left == null || right == null ? 0 : (() => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        })();
         const panels = [...document.querySelectorAll('.tsunami-panel, .quake-panel')]
           .filter((panel) => panel.clientWidth > 0 && panel.clientHeight > 0)
           .map((panel) => {
             const livePage = panel.querySelector('.page-fade');
             const probePage = panel.querySelector('[data-partition-probe-geometry="true"]');
             const body = livePage?.querySelector('.page-body, .page-list-body') ?? null;
             return {
               kind: panel.classList.contains('tsunami-panel') ? 'tsunami' : 'quake',
               panel: measure(panel),
               body: measure(body),
               chrome: measure(livePage?.querySelector('.page-frame, .page-header') ?? null),
               probeChrome: measure(probePage?.querySelector('.page-frame, .page-header') ?? null),
               probeBody: measure(probePage?.querySelector('.partition-probe-body') ?? null),
               indicatorBodyOverlap: overlap(livePage?.querySelector('.page-dots') ?? null, body),
             };
           });
        const briefingCards = [...document.querySelectorAll('.briefing-card')]
          .map((card) => {
            const shelf = card.closest('.measure-shelf, .center-measure-shelf');
            const surface = card.closest('[data-layout-motion-card]')?.getAttribute('data-layout-motion-card') ?? null;
            const placement = shelf == null
              ? surface?.endsWith(':center') ? 'center' : 'side'
              : shelf.classList.contains('center-measure-shelf') ? 'center' : 'side';
            return {
            shelf: shelf != null,
            placement,
            surface,
            probe: card.hasAttribute('data-page-probe-card'),
            probeFit: card.closest('[data-prefix-measure]')?.getAttribute('data-page-probe-fit') ?? null,
            probeId: card.closest('[data-prefix-measure]')?.getAttribute('data-prefix-measure') ?? null,
            probeComposition: card.closest('[data-prefix-measure]')?.getAttribute('data-page-probe-composition') ?? null,
            page: card.getAttribute('data-card-page') ?? '',
            range: card.getAttribute('data-briefing-page-range') ?? '',
            atomRange: card.querySelector('[data-briefing-page-atom]')?.getAttribute('data-briefing-page-atom-range') ?? '',
            shellHeightPx: Number.parseFloat(card.getAttribute('data-briefing-shell-height-px') ?? ''),
            card: measure(card),
            header: measure(card.querySelector('[data-briefing-card-header]')),
            footer: measure(card.querySelector('[data-card-page-footer]')),
            footerText: card.querySelector('[data-card-page-indicator]')?.textContent ?? '',
            pending: card.getAttribute('data-card-page-pending') ?? '',
            frameLevels: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => entry.getAttribute('data-frame-level') ?? ''),
            entryKeys: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => entry.getAttribute('data-briefing-entry') ?? ''),
            entryFacts: [...card.querySelectorAll('[data-briefing-page-atom-entry]')].map((entry) => ({
              precipitationStats: entry.querySelectorAll('[data-briefing-precipitation-stat]').length,
              precipitationLocations: entry.querySelectorAll('[data-briefing-precipitation-location]').length,
              precipitationAmounts: entry.querySelectorAll('[data-briefing-precipitation-amount]').length,
              precipitationTimes: entry.querySelectorAll('[data-briefing-precipitation-time]').length,
              vpoaHeadlines: entry.querySelectorAll('[data-briefing-vpoa-headline]').length,
              vpoaTokens: entry.querySelectorAll('[data-briefing-vpoa-token]').length,
            })),
            readable: [...card.querySelectorAll('[data-page-probe-readable]')].map(measure),
          };
          });
        const standbyHeaders = [...document.querySelectorAll('.standby-card-header')].map((header) => {
          const outer = header.closest('.weather-card, .briefing-card, .heat-card, .flood-card, .flood-wide-card, .typhoon-card, .volcano-card, .quake-card, .quake-replay-card, .tsunami-banner');
          const title = header.querySelector('.standby-card-header__title');
          const meta = header.querySelector('.standby-card-header__meta');
          const headerChildren = [...header.children].map((child, index) => ({
            index,
            kind: child.classList.contains('standby-card-header__title') ? 'title'
              : child.classList.contains('standby-card-header__meta') ? 'meta' : child.className,
            geometry: styled(child, ['display', 'flex', 'flex-shrink', 'overflow', 'text-overflow']),
          }));
          const metaChildren = meta == null ? [] : [...meta.children].map((child, index) => ({
            index,
            kind: child.classList.contains('restored-chip') ? 'restored-chip'
              : child.classList.contains('updated-stamp') ? 'updated-stamp'
                : child.classList.contains('date') ? 'date' : child.className,
            geometry: styled(child, ['display', 'flex-shrink', 'overflow', 'text-overflow']),
          }));
          return {
            card: outer?.className ?? '',
            shelf: outer?.closest('.measure-shelf, .center-measure-shelf') != null,
            outer: styled(outer, ['border-radius', 'overflow']),
            header: styled(header, ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-size', 'font-weight', 'line-height', 'background-color', 'color', 'border-bottom-width']),
            title: styled(title, ['display', 'flex', 'overflow', 'text-overflow', 'white-space']),
            meta: styled(meta, ['display', 'flex-shrink', 'position', 'overflow']),
            headerChildren,
            titleMetaOverlap: overlap(title, meta),
            metaChildOverlaps: meta == null ? [] : [...meta.children].flatMap((left, index, children) =>
              children.slice(index + 1).map((right) => ({
                left: left.className, right: right.className, overlap: overlap(left, right),
              }))),
            metaChildren,
          };
        });
        return { heat: measure(pick('.heat-card')), tsunamiBanner: measure(pick('.tsunami-banner')), panels, briefingCards, standbyHeaders };
      })()`,
    }, attached.sessionId);
    // Entry animations (height reveal) can hold a mid-flight value for several
    // hundred ms, so space the samples wider than any single transition.
    await wait(1500);
    let previous = null;
    let latest = null;
    for (let sample = 0; sample < 15; sample += 1) {
      const result = await evaluateGeometry();
      latest = result.result.value;
      const serialized = JSON.stringify(latest);
      if (previous === serialized) break;
      previous = serialized;
      await wait(1500);
    }
    return latest;
  } finally {
    cdp.close();
    child.kill("SIGTERM");
  }
}

function gateUrl(baseUrl, scenario, rotationTick = null, fixture = null, cardPageTick = null) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  url.searchParams.set("gateScenario", scenario);
  if (rotationTick != null) url.searchParams.set("rotationTick", String(rotationTick));
  if (fixture != null) url.searchParams.set("gateFixture", fixture);
  // The release of an epoch-held logical appearance consumes one, and only
  // one, dependent page step.  The fixture pins that post-release coordinate.
  if (fixture === "tornado-epoch-release") url.searchParams.set("cardPageTick", "1");
  else if (cardPageTick != null) url.searchParams.set("cardPageTick", String(cardPageTick));
  url.hash = fixture === "attention-visibility-emergency"
    ? fixture
    : fixture === "attention-visibility-reduced-motion"
      ? "standby-attention-visibility-reduced-motion"
      : "legacy-standby-gate";
  return url.toString();
}

function decodeHtmlAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function assertCompletePng(contents) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iend = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  if (contents.length < signature.length + iend.length || !signature.every((byte, index) => contents[index] === byte) || !iend.every((byte, index) => contents[contents.length - iend.length + index] === byte)) {
    throw new Error("incomplete PNG artifact");
  }
}

function assertCompleteDom(dom) {
  if (!/<\/html>\s*$/i.test(dom)) throw new Error("incomplete DOM artifact");
}

function diagnosticsFromDom(dom) {
  const attributes = [
    "data-ladder-stage", "data-measurement-settled", "data-layout-unresolved", "data-measurement-nonconverged",
    "data-settle-trace",
    "data-rotation-keys", "data-flood-form", "data-expanded-counts", "data-placement-surplus-use",
    "data-left-track-width-px", "data-center-track-width-px", "data-right-track-width-px",
    "data-side-measure-shelf-width-px", "data-center-measure-shelf-width-px",
    "data-left-track-rect-width-px", "data-center-track-rect-width-px", "data-right-track-rect-width-px",
    "data-side-measure-shelf-rect-width-px", "data-center-measure-shelf-rect-width-px",
    "data-clock-horizontal-clipped", "data-clock-children-horizontal-clipped",
    "data-clock-center-delta-x-px", "data-clock-center-delta-y-px",
    "data-clock-seconds-within-cluster", "data-clock-date-within-cluster",
    "data-recent-hypocenters-horizontal-clipped",
    "data-weather-compact-side-height-px", "data-weather-compact-center-height-px",
    "data-center-cluster-hidden", "data-center-fixed-height-px",
    "data-recent-quakes-rect-top-px", "data-recent-quakes-rect-bottom-px",
    "data-nankai-rect-top-px", "data-nankai-rect-bottom-px", "data-recent-quakes-nankai-overlap-px",
    "data-rotation-active-key", "data-rotation-position", "data-rotation-slot-height-px", "data-rotation-indicator-height-px", "data-rotation-compact-max-height-px",
    "data-rotation-card-viewport-rect-height-px", "data-rotation-footer-rect-height-px", "data-rotation-viewport-footer-overlap-px",
    "data-card-overflow-count",
    "data-card-overflow-keys", "data-page-viewport-overflow-keys",
    "data-geometry-violation-count",
    "data-geometry-violation-keys",
    "data-right-track-scroll-height-px", "data-right-track-client-height-px",
    "data-weather-selected-height-px",
    "data-weather-live-height-px",
    "data-weather-probe-height-px", "data-weather-probe-width-px", "data-weather-live-width-px",
    "data-weather-probe-card-height-px", "data-weather-probe-card-width-px", "data-weather-live-card-height-px", "data-weather-live-card-width-px",
    "data-weather-selected-prefix-id",
    "data-typhoon-title-misalignment-px", "data-page-indicator-body-overlap-px", "data-page-indicator-rider-overlap-px",
    "data-flood-visibility-violation-keys", "data-flood-readable-overflow-keys",
    "data-flood-page", "data-flood-page-keys", "data-flood-page-identities", "data-flood-page-infeasible", "data-flood-page-footer", "data-flood-page-visible-count",
    "data-tornado-page", "data-tornado-page-keys", "data-tornado-page-identities", "data-tornado-page-infeasible", "data-tornado-page-footer", "data-tornado-page-visible-count",
    "data-tornado-page-host", "data-tornado-page-mode", "data-tornado-page-pending-appearance",
    "data-typhoon-variant",
    "data-preview-attention-visibility", "data-preview-reduced-motion", "data-preview-mode",
    "data-tsunami-page", "data-tsunami-page-unseen", "data-tsunami-page-infeasible",
    "data-tsunami-partition-stable", "data-tsunami-partition-diagnostic", "data-tsunami-partition-logical-passes",
    "data-quake-page", "data-quake-page-unseen", "data-quake-page-infeasible",
  ];
  const diagnostics = Object.fromEntries(attributes.map((attribute) => {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}="([^"]*)"`).exec(dom);
    return [attribute, match == null ? null : decodeHtmlAttribute(match[1])];
  }));
  if (diagnostics["data-preview-mode"] !== "emergency" && diagnostics["data-measurement-settled"] !== "true") throw new Error(`measurement did not settle: ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function numberDiagnostic(diagnostics, name) {
  const raw = diagnostics[name];
  if (raw == null || raw === "") throw new Error(`missing numeric diagnostic: ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}: expected a numeric diagnostic, got ${diagnostics[name]}`);
  return value;
}

function assertAttentionPage(diagnostics, prefix) {
  const page = diagnostics[`data-${prefix}-page`];
  const match = /^(\d+)\/(\d+)$/.exec(page ?? "");
  if (match == null || Number(match[2]) < 2) throw new Error(`${prefix} multi-page diagnostic missing: ${page}`);
  const unseen = Number(diagnostics[`data-${prefix}-page-unseen`]);
  if (!Number.isInteger(unseen) || unseen < 0 || unseen > Number(match[2])) throw new Error(`${prefix} unseen diagnostic invalid: ${diagnostics[`data-${prefix}-page-unseen`]}`);
  expectEqual(diagnostics[`data-${prefix}-page-infeasible`], "false", `${prefix} infeasible`);
}

function assertEmergencyGeometry(geometry) {
  const panels = geometry?.panels ?? [];
  if (panels.length < 2) throw new Error(`emergency panels were not measurably rendered: ${JSON.stringify(geometry)}`);
  for (const [index, entry] of panels.entries()) {
    for (const [name, box] of Object.entries({ panel: entry.panel, body: entry.body })) {
      if (box == null || box.clientWidth <= 0 || box.clientHeight <= 0
        || box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1) {
        throw new Error(`emergency ${index} ${name} containment failed: ${JSON.stringify(box)}`);
      }
    }
    if (entry.indicatorBodyOverlap > 0) throw new Error(`emergency ${index} page indicator overlaps body: ${entry.indicatorBodyOverlap}`);
    if (entry.kind !== "tsunami") continue;
    const probeBody = entry.probeBody;
    if (probeBody == null || probeBody.clientWidth <= 0 || probeBody.clientHeight <= 0
      || probeBody.scrollWidth > probeBody.clientWidth + 1 || probeBody.scrollHeight > probeBody.clientHeight + 1) {
      throw new Error(`emergency ${index} probeBody containment failed: ${JSON.stringify(probeBody)}`);
    }
    if (entry.probeChrome == null || entry.chrome == null
      || entry.probeChrome.clientWidth <= 0 || entry.probeChrome.clientHeight <= 0
      || Math.abs(entry.probeChrome.height - entry.chrome.height) > 1) {
      throw new Error(`emergency ${index} probe/live chrome mismatch: ${JSON.stringify(entry)}`);
    }
    if (entry.probeBody == null || entry.body == null
      || Math.abs(entry.probeBody.width - entry.body.width) > 1) {
      throw new Error(`emergency ${index} probe/live body width mismatch: ${JSON.stringify(entry)}`);
    }
  }
}

function assertAttentionVisibilityFixture(dom, diagnostics, fixture, geometry = null, baselineGeometry = null) {
  expectEqual(diagnostics["data-preview-attention-visibility"], "true", "attention fixture marker");
  if (fixture === "attention-visibility-emergency") {
    expectEqual(diagnostics["data-preview-mode"], "emergency", "attention emergency mode");
    assertAttentionPage(diagnostics, "tsunami");
    assertAttentionPage(diagnostics, "quake");
    expectEqual(diagnostics["data-tsunami-partition-stable"], "true", "tsunami partition stable");
    expectEqual(diagnostics["data-tsunami-partition-diagnostic"], "", "tsunami partition diagnostic");
    assertEmergencyGeometry(geometry);
  } else {
    expectEqual(diagnostics["data-preview-mode"], "standby", "attention standby mode");
    if (!dom.includes("data-static-anchor")) throw new Error("attention fixture static anchor missing");
    if (!dom.includes("対象40")) throw new Error("attention fixture Heat 40-area anchor missing");
    const heat = geometry?.heat;
    if (heat == null || heat.clientHeight > 161 || heat.scrollHeight > heat.clientHeight + 1) throw new Error(`Heat live geometry violates 160px containment: ${JSON.stringify(heat)}`);
    const banner = geometry?.tsunamiBanner;
    const baseline = baselineGeometry?.tsunamiBanner;
    if (banner == null || baseline == null || Math.abs(banner.height - baseline.height) > 1) throw new Error(`tsunami banner baseline differs by more than 1px: ${JSON.stringify({ banner, baseline })}`);
    // Svelte scopes the class attribute (e.g. class="magnitude stat-value svelte-…"),
    // so match the leading token rather than the whole attribute value — and require
    // each of the three columns individually so 3 hits of one class cannot mask the rest.
    if (["magnitude", "depth", "time"].some((token) => !new RegExp(`class="${token}(?=["\\s])`).test(dom))) throw new Error("RecentQuakes statistics three columns missing");
    expectEqual(diagnostics["data-preview-reduced-motion"], fixture === "attention-visibility-reduced-motion" ? "true" : null, "attention reduced-motion marker");
  }
}

function assertNarrowGeometry(diagnostics, scenario, viewport) {
  if (viewport.label !== "960x620") return;
  if (scenario === "quiet") expectEqual(diagnostics["data-ladder-stage"], "0", "960px quiet stage");
  // Scenario 7 includes the tornado rider. Its 44vh contract height is
  // reserved before partition confirmation, so at 960px weather joins the
  // rotation slot just as max does.
  if (scenario === "max" || scenario === "7") {
    expectEqual(diagnostics["data-ladder-stage"], "3", `960px scenario-${scenario} stage (§5)`);
    expectEqual(diagnostics["data-rotation-keys"], "weather,flood,typhoon,volcano,heat", `960px scenario-${scenario} rotation set (§5)`);
    expectEqual(diagnostics["data-layout-unresolved"], "false", `960px scenario-${scenario} resolved layout (§5)`);
  }
  if (scenario !== "quiet") expectEqual(diagnostics["data-recent-hypocenters-horizontal-clipped"], "false", "960px recent-quake hypocenter clipping");
  if (scenario !== "quiet" && scenario !== "max") return;
  const left = numberDiagnostic(diagnostics, "data-left-track-width-px");
  const center = numberDiagnostic(diagnostics, "data-center-track-width-px");
  const right = numberDiagnostic(diagnostics, "data-right-track-width-px");
  const sideShelf = numberDiagnostic(diagnostics, "data-side-measure-shelf-width-px");
  const centerShelf = numberDiagnostic(diagnostics, "data-center-measure-shelf-width-px");
  const leftRect = numberDiagnostic(diagnostics, "data-left-track-rect-width-px");
  const centerRect = numberDiagnostic(diagnostics, "data-center-track-rect-width-px");
  const rightRect = numberDiagnostic(diagnostics, "data-right-track-rect-width-px");
  const sideShelfRect = numberDiagnostic(diagnostics, "data-side-measure-shelf-rect-width-px");
  const centerShelfRect = numberDiagnostic(diagnostics, "data-center-measure-shelf-rect-width-px");
  if (left < 280 || right < 280 || leftRect < 280 || rightRect < 280) throw new Error(`960px side track below readable width: ${left}/${right} diag, ${leftRect}/${rightRect} rect`);
  for (const [label, diagnostic, rect] of [["left", left, leftRect], ["center", center, centerRect], ["right", right, rightRect]]) {
    if (Math.abs(diagnostic - rect) > 1) throw new Error(`960px ${label} track diagnostic/rect mismatch: ${diagnostic}/${rect}`);
  }
  if (Math.abs(sideShelf - left) > 1 || Math.abs(sideShelfRect - leftRect) > 1) throw new Error(`960px side shelf/track mismatch: ${sideShelf}/${left} diag, ${sideShelfRect}/${leftRect} rect`);
  if (Math.abs(centerShelf - center) > 1 || Math.abs(centerShelfRect - centerRect) > 1) throw new Error(`960px center shelf/track mismatch: ${centerShelf}/${center} diag, ${centerShelfRect}/${centerRect} rect`);
  expectEqual(diagnostics["data-clock-horizontal-clipped"], "false", "960px clock horizontal clipping");
  expectEqual(diagnostics["data-clock-children-horizontal-clipped"], "false", "960px clock child horizontal clipping");
}

function stageZeroClockMismatches(diagnostics) {
  if (diagnostics["data-ladder-stage"] !== "0") return [];
  const dx = numberDiagnostic(diagnostics, "data-clock-center-delta-x-px");
  const dy = numberDiagnostic(diagnostics, "data-clock-center-delta-y-px");
  return [
    ...(dx <= 1 ? [] : [{ key: "clockCenterDeltaX", expected: "<=1", actual: String(dx) }]),
    ...(dy <= 1 ? [] : [{ key: "clockCenterDeltaY", expected: "<=1", actual: String(dy) }]),
    ...(diagnostics["data-clock-seconds-within-cluster"] === "true" ? [] : [{ key: "clockSecondsWithinCluster", expected: "true", actual: diagnostics["data-clock-seconds-within-cluster"] }]),
    ...(diagnostics["data-clock-date-within-cluster"] === "true" ? [] : [{ key: "clockDateWithinCluster", expected: "true", actual: diagnostics["data-clock-date-within-cluster"] }]),
  ];
}

function assertStageZeroClock(diagnostics) {
  const mismatches = stageZeroClockMismatches(diagnostics);
  if (mismatches.length > 0) throw new Error(`stage-0 clock geometry invalid: ${JSON.stringify(mismatches)}`);
}

function assertNankaiSeparation(diagnostics) {
  const overlap = numberDiagnostic(diagnostics, "data-recent-quakes-nankai-overlap-px");
  if (overlap > 0) throw new Error(`recent-quakes/Nankai overlap: ${overlap}px`);
}

function assertCardContainment(diagnostics) {
  const overflow = numberDiagnostic(diagnostics, "data-card-overflow-count");
  if (overflow !== 0) throw new Error(`card scroll containment invalid: ${overflow} overflowing card(s): ${diagnostics["data-card-overflow-keys"]}; paged viewport: ${diagnostics["data-page-viewport-overflow-keys"]}`);
}

function assertBriefingPagingFixture(geometry, { expectedPage, expectedFooter, expectedEntryBoundary, expectTokenizedVpoa }) {
  const cards = geometry?.briefingCards ?? [];
  const live = cards.filter((card) => !card.shelf);
  const probes = cards.filter((card) => card.shelf && card.probe);
  if (live.length !== 1 || probes.length === 0) throw new Error(`briefing page atoms missing: ${JSON.stringify({ live: live.length, probes: probes.length })}`);
  const fits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
  // Match StandbyScreen's probe budget exactly: the declared live shell is
  // border-box, while shelf scrollHeight is padding-box. A natural probe's
  // own clientHeight is not a budget; use the live shell height instead.
  const liveShellHeight = live[0].shellHeightPx;
  const liveShellBorder = live[0].card?.verticalBorderPx ?? Number.NaN;
  if (!Number.isFinite(liveShellHeight) || !Number.isFinite(liveShellBorder)) {
    throw new Error(`briefing live shell budget missing: ${JSON.stringify(live[0])}`);
  }
  const liveShellContentBudget = Math.max(0, liveShellHeight - liveShellBorder);
  const briefingProbeFits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1
    && box.scrollHeight <= liveShellContentBudget + 1;
  if (live[0].pending !== "false") throw new Error(`briefing live partition remained pending: ${JSON.stringify(live[0])}`);
  if (!fits(live[0].card)) throw new Error(`briefing live card containment failed: ${JSON.stringify(live[0])}`);
  for (const card of [...live, ...probes]) {
    if (card.header == null || card.readable.length === 0 || card.readable.some((readable) => !fits(readable))) {
      throw new Error(`briefing atom readable containment failed: ${JSON.stringify(card)}`);
    }
  }
  for (const probe of probes) {
    if (probe.probeFit !== "true" && probe.probeFit !== "false"
      || briefingProbeFits(probe.card) !== (probe.probeFit === "true")) {
      throw new Error(`briefing probe card fit disagrees with measured result: ${JSON.stringify(probe)}`);
    }
  }
  // side and center shelves can produce the same logical range.  The live
  // card must only be compared with the probe from its actual surface; range
  // alone previously selected the first shelf entry nondeterministically.
  const matchingProbe = probes.find((probe) => probe.placement === live[0].placement
    && probe.range === live[0].range && probe.atomRange === live[0].atomRange);
  // Probes are natural-height measurements while the live card fills its
  // fixed shell, so their outer card heights deliberately differ. Compare the
  // atom itself instead: chrome, entry identity, and every readable body box.
  const sameValues = (left, right) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  const readableHeightsMatch = matchingProbe != null
    && matchingProbe.readable.length === live[0].readable.length
    && matchingProbe.readable.every((readable, index) => {
      const liveReadable = live[0].readable[index];
      return readable != null && liveReadable != null
        && Math.abs(readable.height - liveReadable.height) <= 1;
    });
  if (matchingProbe == null || Math.abs(matchingProbe.card.width - live[0].card.width) > 1
    || !sameValues(matchingProbe.entryKeys, live[0].entryKeys)
    || !sameValues(matchingProbe.frameLevels, live[0].frameLevels)
    || !readableHeightsMatch
    || matchingProbe.header == null || Math.abs(matchingProbe.header.height - live[0].header.height) > 1
    || (matchingProbe.footer == null) !== (live[0].footer == null)
    || matchingProbe.footerText !== live[0].footerText
    || (matchingProbe.footer != null && live[0].footer != null
      && (Math.abs(matchingProbe.footer.width - live[0].footer.width) > 1
        || Math.abs(matchingProbe.footer.height - live[0].footer.height) > 1))) {
    throw new Error(`briefing probe/live atom mismatch: ${JSON.stringify({ live: live[0], matchingProbe })}`);
  }
  if (expectedEntryBoundary) {
    const frameLevels = new Set(probes.flatMap((card) => card.frameLevels));
    if (!frameLevels.has("critical") || !frameLevels.has("warning") || !probes.some((card) => card.frameLevels.length > 1)) {
      throw new Error(`briefing entry chrome boundary missing: ${JSON.stringify(probes)}`);
    }
  }
  if (live[0].page !== expectedPage || (live[0].footer != null) !== expectedFooter
    || !probes.every((card) => (card.footer != null) === expectedFooter)) {
    throw new Error(`briefing page footer contract failed: ${JSON.stringify({ expectedPage, expectedFooter, live: live[0], probes })}`);
  }
  const entryFacts = cards.flatMap((card) => card.entryFacts ?? []);
  if (!entryFacts.some((facts) => facts.precipitationStats > 0 && facts.precipitationLocations > 0
    && facts.precipitationAmounts > 0 && facts.precipitationTimes > 0)
    || expectTokenizedVpoa && (!entryFacts.some((facts) => facts.vpoaHeadlines > 0 && facts.vpoaTokens > 0)
      || entryFacts.some((facts) => facts.vpoaHeadlines > 0 && facts.precipitationStats > 0))) {
    throw new Error(`briefing fact selector contract failed: ${JSON.stringify(entryFacts)}`);
  }
}

function assertRecentQuakesNarrowFixture(diagnostics) {
  expectEqual(diagnostics["data-recent-hypocenters-horizontal-clipped"], "false", "recent-quakes-narrow hypocenter clipping");
}

function assertFloodReadability(diagnostics) {
  const visibilityKeys = diagnostics["data-flood-visibility-violation-keys"];
  if (visibilityKeys == null) throw new Error("flood visibility diagnostic is missing");
  if (visibilityKeys !== "") throw new Error(`flood visibility invalid: ${visibilityKeys}`);
  const overflowKeys = diagnostics["data-flood-readable-overflow-keys"];
  if (overflowKeys == null) throw new Error("flood readability diagnostic is missing");
  if (overflowKeys !== "") throw new Error(`flood readability invalid: ${overflowKeys}`);
}

function assertGeometry(diagnostics, { skipWeatherHeight = false } = {}) {
  const selectedWeather = numberDiagnostic(diagnostics, "data-weather-selected-height-px");
  const liveWeather = numberDiagnostic(diagnostics, "data-weather-live-height-px");
  if (!skipWeatherHeight && selectedWeather > 0 && liveWeather > 0 && Math.abs(selectedWeather - liveWeather) > 1) throw new Error(`weather probe/live height mismatch: ${selectedWeather} != ${liveWeather}`);
  const probeCardWidth = numberDiagnostic(diagnostics, "data-weather-probe-card-width-px");
  const liveCardWidth = numberDiagnostic(diagnostics, "data-weather-live-card-width-px");
  if (!skipWeatherHeight && probeCardWidth > 0 && liveCardWidth > 0 && Math.abs(probeCardWidth - liveCardWidth) > 1) throw new Error(`weather probe/live card-width mismatch: ${probeCardWidth} != ${liveCardWidth}`);
  const violations = numberDiagnostic(diagnostics, "data-geometry-violation-count");
  if (violations !== 0) throw new Error(`card/viewport/clock/nankai geometry invalid: ${violations} violation(s): ${diagnostics["data-geometry-violation-keys"]}`);
  if (numberDiagnostic(diagnostics, "data-typhoon-title-misalignment-px") > 2) throw new Error("typhoon title/location rows are misaligned");
  if (numberDiagnostic(diagnostics, "data-page-indicator-body-overlap-px") > 0) throw new Error("page indicator overlaps its body");
  if (numberDiagnostic(diagnostics, "data-page-indicator-rider-overlap-px") > 0) throw new Error("page indicator overlaps the tornado rider");
}

function assertClusterFixture(diagnostics, { requirePreRotation = false } = {}) {
  const hidden = (diagnostics["data-center-cluster-hidden"] ?? "").split(",");
  if (!hidden.includes("stats")) throw new Error("cluster fixture did not reduce stats");
  expectEqual(diagnostics["data-layout-unresolved"], "false", "cluster fixture resolved layout");
  if (numberDiagnostic(diagnostics, "data-recent-quakes-nankai-overlap-px") !== 0) throw new Error("cluster fixture overlaps Nankai band");
  if (requirePreRotation) {
    // data-center-fixed-height-px is the POST-reduction fixed cluster height:
    // once both stats and recent-quakes are hidden it legitimately reads 0.
    // The non-empty hidden list above already proves there was a cluster to
    // reduce, so only reject when nothing was hidden AND nothing is left.
    if (hidden.filter(Boolean).length === 0 && numberDiagnostic(diagnostics, "data-center-fixed-height-px") <= 0) throw new Error("cluster-calm fixture has no fixed cluster to reduce");
    if (Number(diagnostics["data-ladder-stage"]) > 2) throw new Error(`cluster-calm fixture escaped stage 0–2: ${diagnostics["data-ladder-stage"]}`);
  }
}

function assertClockHandoff(dom, diagnostics) {
  const stage = Number(diagnostics["data-ladder-stage"]);
  const tickerClock = /class="[^"]*ticker-clock[^"]*"/.test(dom);
  const centralAway = /class="[^"]*clock-landmark[^"]*clock-away[^"]*"/.test(dom);
  if (stage === 0 && (tickerClock || centralAway)) throw new Error("stage 0 clock handoff is not exclusive");
  if (stage >= 1 && (!tickerClock || !centralAway)) throw new Error("evacuated clock is not rendered in ticker exclusively");
}

function assertRotationDiagnostics(diagnostics, rotationTick) {
  if (rotationTick == null || diagnostics["data-ladder-stage"] !== "3") return;
  const keys = (diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
  if (keys.length === 0) throw new Error("stage 3 has no rotation keys");
  const expectedKey = keys[rotationTick % keys.length];
  expectEqual(diagnostics["data-rotation-active-key"], expectedKey, `rotation tick ${rotationTick} active key`);
  expectEqual(diagnostics["data-rotation-position"], `${rotationTick % keys.length + 1}/${keys.length}`, `rotation tick ${rotationTick} position`);
  const slot = numberDiagnostic(diagnostics, "data-rotation-slot-height-px");
  const indicator = numberDiagnostic(diagnostics, "data-rotation-indicator-height-px");
  const compactMax = numberDiagnostic(diagnostics, "data-rotation-compact-max-height-px");
  if (Math.abs(slot - (compactMax + indicator)) > 1) throw new Error(`rotation slot reservation mismatch: ${slot} != ${compactMax} + ${indicator}`);
  const viewport = numberDiagnostic(diagnostics, "data-rotation-card-viewport-rect-height-px");
  const footer = numberDiagnostic(diagnostics, "data-rotation-footer-rect-height-px");
  const overlap = numberDiagnostic(diagnostics, "data-rotation-viewport-footer-overlap-px");
  if (viewport <= 0 || footer <= 0 || overlap > 0) throw new Error(`rotation viewport/footer geometry invalid: viewport=${viewport}, footer=${footer}, overlap=${overlap}`);
}

const FLOOD_NONE = { floodForm: "none", floodPage: "0/0", floodPageKeys: "[]", floodPageIdentities: "[]", floodPageFooter: "false", floodVisibleCount: "0", floodInfeasible: "false" };
// 2026-08-23 Chrome observed values. The three forms cover every table cell:
// no rider, permanent weather host, and rotation-hosted weather.
const TORNADO_EXPECTATIONS = {
  none: { tornadoPage: "0/0", tornadoPageKeys: "[]", tornadoPageIdentities: "[]", tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "", tornadoMode: "real", tornadoPendingAppearance: "false" },
  real: { tornadoPage: "1/1", tornadoPageKeys: '["宮崎県南部平野部"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0"]', tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "2", tornadoHost: "weather", tornadoMode: "real", tornadoPendingAppearance: "false" },
  logical: { tornadoPage: "1/1", tornadoPageKeys: '["宮崎県南部平野部"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0"]', tornadoInfeasible: "false", tornadoFooter: "false", tornadoVisibleCount: "2", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" },
};
const TORNADO_IMPOSSIBLE_AREA = "宮崎県南部平野部（竜巻注意情報の可読性とページ分割を確認するための極端に長い対象地域名）".repeat(8);
const TORNADO_IMPOSSIBLE_KEYS = JSON.stringify([TORNADO_IMPOSSIBLE_AREA]);
const TORNADO_IMPOSSIBLE_IDENTITIES = JSON.stringify([`tornado|${TORNADO_IMPOSSIBLE_AREA}|0`]);
// Dedicated real-Chrome cells, promoted only after observed output was checked
// against the §3.3 / §3.5 pager and infeasible contracts.
const TORNADO_FIXTURE_EXPECTATIONS = Object.freeze({
  "tornado-pages": { "7": { "1280x720": { tornadoPage: "1/5", tornadoPageKeys: '["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅地方","熊本県球磨地方","大分県佐伯市"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0","tornado|宮崎県北部平野部|0","tornado|鹿児島県大隅地方|0","tornado|熊本県球磨地方|0","tornado|大分県佐伯市|0"]', tornadoInfeasible: "false", tornadoFooter: "true", tornadoVisibleCount: "1", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-aggregate": { "7": { "960x620": { tornadoPage: "1/1", tornadoPageKeys: TORNADO_IMPOSSIBLE_KEYS, tornadoPageIdentities: TORNADO_IMPOSSIBLE_IDENTITIES, tornadoInfeasible: "aggregate", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-clip": { "7": { "960x620": { tornadoPage: "1/1", tornadoPageKeys: TORNADO_IMPOSSIBLE_KEYS, tornadoPageIdentities: TORNADO_IMPOSSIBLE_IDENTITIES, tornadoInfeasible: "clip", tornadoFooter: "false", tornadoVisibleCount: "0", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
  "tornado-epoch-release": { "7": { "1280x720": { tornadoPage: "2/5", tornadoPageKeys: '["宮崎県南部平野部","宮崎県北部平野部","鹿児島県大隅地方","熊本県球磨地方","大分県佐伯市"]', tornadoPageIdentities: '["tornado|宮崎県南部平野部|0","tornado|宮崎県北部平野部|0","tornado|鹿児島県大隅地方|0","tornado|熊本県球磨地方|0","tornado|大分県佐伯市|0"]', tornadoInfeasible: "false", tornadoFooter: "true", tornadoVisibleCount: "1", tornadoHost: "weather", tornadoMode: "logical", tornadoPendingAppearance: "false" } } },
});
function tornadoExpectation(scenario, viewport) {
  if (scenario === "quiet") return TORNADO_EXPECTATIONS.none;
  return (scenario === "4" && viewport.label === "960x620")
    || (scenario !== "4" && ["1280x720", "960x620"].includes(viewport.label))
    ? TORNADO_EXPECTATIONS.logical
    : TORNADO_EXPECTATIONS.real;
}
const FLOOD_CARD_TWO = { floodForm: "card", floodPage: "1/2", floodPageKeys: '["大淀川","五ヶ瀬川"]', floodPageIdentities: '["氾濫危険情報|大淀川|0|code:8303040001","氾濫警戒情報|五ヶ瀬川|0|code:8303040003"]', floodPageFooter: "true", floodVisibleCount: "2", floodInfeasible: "false" };
const FLOOD_CARD_ONE = { floodForm: "card", floodPage: "1/1", floodPageKeys: '["大淀川"]', floodPageIdentities: '["氾濫危険情報|大淀川|0|code:8303040001"]', floodPageFooter: "false", floodVisibleCount: "3", floodInfeasible: "false" };
const FLOOD_WIDE_EXPECTATIONS = {
  "1920x1080": { stage: "1", rotationKeys: "", typhoonVariant: "compact", floodForm: "wide", floodPage: "1/2", floodPageKeys: '["大淀川","一ツ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫警戒情報|一ツ瀬川|0|code:8303040005"]', floodPageFooter: "true", floodVisibleCount: "4", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 24, n: 0 } } }, surplus: "21" },
  "1280x720": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", typhoonVariant: "compact", floodForm: "card", floodPage: "1/2", floodPageKeys: '["大淀川","五ヶ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫危険情報|五ヶ瀬川|0|code:8303040003"]', floodPageFooter: "true", floodVisibleCount: "0", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 3, n: 21 } } }, surplus: "0" },
};

// §5 / §11.1 fixed tables. --report emits this comparison without mutating
// either source of truth, so a newly measured table needs an explicit ruling.
const TABLE_EXPECTATIONS = {
  quiet: { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "0", rotationKeys: "", ...FLOOD_NONE } },
  "4": { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "2", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "3", rotationKeys: "weather,volcano,heat", ...FLOOD_NONE } },
  "7": { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1280x720": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
  max: { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1280x720": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
};
// §11.1 C, keyed independently of the §5 ladder table. Keeping the measured
// payload here makes --report reject a stage match with stale expansion data.
const UTIL_EXPECTATIONS = {
  // In §11.1's human table "−（不在）" is encoded as the always-emitted
  // diagnostic value "none"; absence is never represented by a missing attr.
  "4": { "1920x1080": ["none", "none", 7, 0, 12, 0, 13, "false"], "1512x982": ["none", "none", 7, 0, 12, 0, 13, "false"], "1280x720": ["none", "none", 7, 0, 12, 0, 13, "false"], "960x620": ["none", "none", 7, 0, 2, 10, 3, "false"] },
  "7": { "1920x1080": ["full", "card", 7, 0, 12, 0, 14, "false"], "1512x982": ["compact", "card", 7, 0, 12, 0, 13, "false"], "1280x720": ["compact", "card", 4, 3, 2, 10, 0, "false"], "960x620": ["compact", "card", 4, 3, 2, 10, 0, "false"] },
  // Header unification lowers the quake/tsunami chrome by 8px. At 1920px
  // this admits Typhoon's full promotion (+1 surplus unit); at 1512px it
  // admits the final three quake prefix rows (7 shown, no omitted tail).
  max: { "1920x1080": ["full", "card", 7, 0, 24, 0, 25, "false"], "1512x982": ["compact", "card", 7, 0, 24, 0, 24, "false"], "1280x720": ["compact", "card", 4, 3, 3, 21, 0, "false"], "960x620": ["compact", "card", 4, 3, 3, 21, 0, "false"] },
};

function tableMismatches(diagnostics, scenario, viewport, fixture = null) {
  const fixtureExpected = fixture == null ? null : TORNADO_FIXTURE_EXPECTATIONS[fixture]?.[scenario]?.[viewport.label];
  const baseExpected = scenario === "max-floodWide"
    ? FLOOD_WIDE_EXPECTATIONS[viewport.label]
    : (() => {
      const base = TABLE_EXPECTATIONS[scenario]?.[viewport.label];
      const util = UTIL_EXPECTATIONS[scenario]?.[viewport.label];
      const combined = base == null || util == null ? base : { ...base, typhoonVariant: util[0], floodForm: util[1], expandedCounts: { quake: { count: util[2], n: util[3] }, weather: { "大雨警報(土砂災害)": { count: util[4], n: util[5] } } }, surplus: String(util[6]), floodInfeasible: util[7] };
      return combined;
    })();
  const expected = fixtureExpected ?? (baseExpected == null ? null : { ...baseExpected, ...tornadoExpectation(scenario, viewport) });
  if (expected == null) return [];
  const observed = {
    stage: diagnostics["data-ladder-stage"], rotationKeys: diagnostics["data-rotation-keys"],
    unresolved: diagnostics["data-layout-unresolved"], nonconverged: diagnostics["data-measurement-nonconverged"],
    centerClusterHidden: diagnostics["data-center-cluster-hidden"], floodForm: diagnostics["data-flood-form"], floodInfeasible: diagnostics["data-flood-page-infeasible"],
    floodPage: diagnostics["data-flood-page"], floodPageKeys: diagnostics["data-flood-page-keys"], floodPageIdentities: diagnostics["data-flood-page-identities"],
    floodPageFooter: diagnostics["data-flood-page-footer"], floodVisibleCount: diagnostics["data-flood-page-visible-count"],
    tornadoPage: diagnostics["data-tornado-page"], tornadoPageKeys: diagnostics["data-tornado-page-keys"], tornadoPageIdentities: diagnostics["data-tornado-page-identities"],
    tornadoInfeasible: diagnostics["data-tornado-page-infeasible"], tornadoFooter: diagnostics["data-tornado-page-footer"], tornadoVisibleCount: diagnostics["data-tornado-page-visible-count"],
    tornadoHost: diagnostics["data-tornado-page-host"], tornadoMode: diagnostics["data-tornado-page-mode"], tornadoPendingAppearance: diagnostics["data-tornado-page-pending-appearance"],
    typhoonVariant: diagnostics["data-typhoon-variant"], expandedCounts: diagnostics["data-expanded-counts"],
    surplus: diagnostics["data-placement-surplus-use"],
  };
  const expectedValues = fixtureExpected == null
    ? { stage: expected.stage, rotationKeys: expected.rotationKeys, unresolved: "false", nonconverged: "false", centerClusterHidden: "" }
    : {};
  for (const key of ["floodForm", "floodInfeasible", "floodPage", "floodPageKeys", "floodPageIdentities", "floodPageFooter", "floodVisibleCount", "typhoonVariant", "expandedCounts", "surplus", ...Object.keys(TORNADO_EXPECTATIONS.none)]) {
    if (expected[key] != null) expectedValues[key] = key === "expandedCounts" ? JSON.stringify(expected[key]) : expected[key];
  }
  return [
    ...Object.entries(expectedValues).flatMap(([key, value]) => observed[key] === value ? [] : [{ key, expected: value, actual: observed[key] }]),
    ...(fixtureExpected == null ? stageZeroClockMismatches(diagnostics) : []),
  ];
}

function assertTableDiagnostics(diagnostics, scenario, viewport, fixture = null) {
  const mismatches = tableMismatches(diagnostics, scenario, viewport, fixture);
  if (mismatches.length > 0) throw new Error(`${viewport.label} scenario-${scenario} table mismatch: ${JSON.stringify(mismatches)}`);
}

function assertFloodWideDiagnostics(diagnostics, scenario, viewport) {
  if (scenario !== "max-floodWide") return;
  const expected = FLOOD_WIDE_EXPECTATIONS[viewport.label];
  if (expected == null) return;
  expectEqual(diagnostics["data-ladder-stage"], expected.stage, `${viewport.label} floodWide stage`);
  expectEqual(diagnostics["data-rotation-keys"], expected.rotationKeys, `${viewport.label} floodWide rotation keys`);
  expectEqual(diagnostics["data-flood-form"], expected.floodForm, `${viewport.label} floodWide form`);
  expectEqual(diagnostics["data-placement-surplus-use"], expected.surplus, `${viewport.label} floodWide surplus`);
  const expandedCounts = JSON.parse(diagnostics["data-expanded-counts"] ?? "null");
  if (JSON.stringify(expandedCounts) !== JSON.stringify(expected.expandedCounts)) throw new Error(`${viewport.label} floodWide expanded counts: expected ${JSON.stringify(expected.expandedCounts)}, got ${JSON.stringify(expandedCounts)}`);
  expectEqual(diagnostics["data-measurement-nonconverged"], "false", `${viewport.label} floodWide convergence`);
  if (viewport.label === "1280x720") expectEqual(diagnostics["data-flood-readable-overflow-keys"], "", "1280x720 flood station/kind readability");
}

async function capture({ chrome, profileDir, url, scenario, viewport, outDir, rotationTick = null, cardPageTick = null, assertTable = true, fixture = null }) {
  const tickSuffix = rotationTick == null ? "" : `-tick-${rotationTick}`;
  const cardPageTickSuffix = cardPageTick == null ? "" : `-page-tick-${cardPageTick}`;
  const fixtureSuffix = fixture == null ? "" : `-${fixture}`;
  const stem = `legacy-standby-${scenario}-${viewport.label}${fixtureSuffix}${tickSuffix}${cardPageTickSuffix}`;
  const pngPath = join(outDir, `${stem}.png`);
  const jsonPath = join(outDir, `${stem}.json`);
  const domPath = join(outDir, `${stem}.dom.html`);
  const chromeArgs = [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--user-data-dir=${profileDir}`,
    `--window-size=${viewport.width},${viewport.height}`, "--virtual-time-budget=10000", url,
  ];
  await rm(pngPath, { force: true });
  await run(chrome, [...chromeArgs.slice(0, -1), `--screenshot=${pngPath}`, url], null, pngPath);
  assertCompletePng(await readFile(pngPath));
  const domFile = await open(domPath, "w");
  try {
    await run(chrome, [...chromeArgs.slice(0, -1), "--dump-dom", url], domFile.fd, domPath);
  } finally {
    await domFile.close();
  }
  const dom = await readFile(domPath, "utf8");
  assertCompleteDom(dom);
  const diagnostics = diagnosticsFromDom(dom);
  const attentionFixture = fixture != null && ATTENTION_VISIBILITY_FIXTURES.has(fixture);
  const clusterFixture = url.includes("gateFixture=cluster");
  const clusterCalmFixture = url.includes("gateFixture=cluster-calm");
  let attentionGeometry = null;
  if (attentionFixture || fixture === "briefing-pages" || fixture === "briefing-single-page" || process.argv.includes("--report")) {
    attentionGeometry = await captureLiveGeometry({ chrome, profileDir, url, viewport });
    if (attentionFixture) {
      const baselineUrl = new URL(url);
      baselineUrl.search = "nav=0";
      baselineUrl.hash = "standby-cards";
      const baselineGeometry = fixture === "attention-visibility-emergency"
        ? null
        : await captureLiveGeometry({ chrome, profileDir, url: baselineUrl.toString(), viewport });
      assertAttentionVisibilityFixture(dom, diagnostics, fixture, attentionGeometry, baselineGeometry);
    } else if (fixture === "briefing-pages" || fixture === "briefing-single-page") {
      assertBriefingPagingFixture(attentionGeometry, fixture === "briefing-pages"
        ? { expectedPage: `${(cardPageTick ?? 0) + 1}/${BRIEFING_PAGING_PAGE_COUNT}`, expectedFooter: true, expectedEntryBoundary: true, expectTokenizedVpoa: true }
        : { expectedPage: "1/1", expectedFooter: false, expectedEntryBoundary: false, expectTokenizedVpoa: false });
    }
  }
  // EmergencyScreen has no StandbyScreen layout tracks. It instead runs the live panel
  // containment and indicator-overlap checks above; only track-specific probes are inapplicable.
  if (fixture !== "attention-visibility-emergency") {
    if (!clusterFixture) assertNarrowGeometry(diagnostics, scenario, viewport);
    assertNankaiSeparation(diagnostics);
    assertStageZeroClock(diagnostics);
    // With an explicit flood-bearing scenario (for example
    // --scenario 7 --fixture overflow), run this before generic containment so
    // the fixture proves the flood root-clipping diagnostic itself. The default
    // fixture starts at quiet, which has no flood card and intentionally falls
    // through to the generic containment counterexample.
    assertFloodReadability(diagnostics);
    assertCardContainment(diagnostics);
    if (fixture === "recent-quakes-narrow") assertRecentQuakesNarrowFixture(diagnostics);
    assertGeometry(diagnostics, { skipWeatherHeight: clusterFixture });
    if (clusterFixture) assertClusterFixture(diagnostics, { requirePreRotation: clusterCalmFixture });
    assertClockHandoff(dom, diagnostics);
    if (!clusterFixture) assertRotationDiagnostics(diagnostics, rotationTick);
    if (assertTable && fixture == null) {
      assertTableDiagnostics(diagnostics, scenario, viewport, fixture);
      assertFloodWideDiagnostics(diagnostics, scenario, viewport);
    }
  }
  const report = { scenario, fixture, rotationTick, viewport: { width: viewport.width, height: viewport.height }, url, pngPath, diagnostics, geometry: attentionGeometry, mismatches: tableMismatches(diagnostics, scenario, viewport, fixture) };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(domPath, { force: true });
  return { scenario, fixture, viewport, rotationTick, cardPageTick, pngPath, jsonPath, diagnostics, geometry: attentionGeometry, mismatches: tableMismatches(diagnostics, scenario, viewport, fixture) };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  if (options == null) { usage(); return; }
  // The overlap counterexample needs the first paged weather+tornado cell.
  // Scenario 7 / 960 is that deterministic surface; starting from quiet would
  // exercise no badge at all and could leave the rider diagnostic unproven.
  const overlapDefault = options.fixture === "overlap" && options.scenarios.length === 0;
  const fixtureDefaults = {
    "tornado-pages": { scenario: "7", viewport: "1280x720" },
    "tornado-aggregate": { scenario: "7", viewport: "960x620" },
    "tornado-clip": { scenario: "7", viewport: "960x620" },
    "tornado-epoch-release": { scenario: "7", viewport: "1280x720" },
    "recent-quakes-narrow": { scenario: "quiet", viewport: "960x620" },
    "attention-visibility-standby": { scenario: "max", viewport: "1280x720" },
    "attention-visibility-emergency": { scenario: "max", viewport: "1280x720" },
    "attention-visibility-reduced-motion": { scenario: "max", viewport: "1280x720" },
    "briefing-pages": { scenario: "4", viewport: "1280x720" },
    "briefing-single-page": { scenario: "4", viewport: "1280x720" },
  };
  const fixtureDefault = options.fixture == null ? null : fixtureDefaults[options.fixture] ?? null;
  const scenarios = options.scenarios.length === 0
    ? fixtureDefault?.scenario != null ? [fixtureDefault.scenario] : overlapDefault ? ["7"] : DEFAULT_SCENARIOS
    : options.scenarios;
  if (scenarios.some((scenario) => !SUPPORTED_SCENARIOS.includes(scenario))) throw new Error("scenario must be quiet, 4, 7, max, or max-floodWide");
  if (options.fixture != null && !["overflow", "overlap", "rotation", "cluster", "cluster-calm", "tornado-pages", "tornado-aggregate", "tornado-clip", "tornado-epoch-release", "recent-quakes-narrow", "attention-visibility-standby", "attention-visibility-emergency", "attention-visibility-reduced-motion", "briefing-pages", "briefing-single-page"].includes(options.fixture)) throw new Error("unknown fixture");
  if (options.fixture === "cluster-calm" && (scenarios.length !== 1 || scenarios[0] !== "4")) throw new Error("cluster-calm fixture requires --scenario 4: quiet has no fixed cluster to reduce");
  const requestedViewports = options.viewports.length === 0 ? null : options.viewports.map(parseViewport);
  const outDir = resolve(options.outDir ?? join(DISPLAY_DIR, "artifacts", "legacy-standby"));
  await mkdir(outDir, { recursive: true });
  const chrome = process.env.CHROME_BIN ?? "chrome";
  const staticServer = options.url == null ? await startStaticServer() : null;
  const baseUrl = options.url ?? staticServer.url;
  const profileDir = await mkdtemp(join(outDir, ".chrome-profile-"));
  try {
    const results = [];
    for (const scenario of scenarios) {
      const viewportLabels = requestedViewports == null
        ? fixtureDefault?.viewport != null ? [fixtureDefault.viewport]
          : overlapDefault ? ["960x620"]
          : scenario === "max-floodWide" ? FLOOD_WIDE_VIEWPORTS : options.report ? DEFAULT_VIEWPORTS : scenario === "quiet" ? ["960x620"] : DEFAULT_VIEWPORTS
        : requestedViewports.map((viewport) => viewport.label);
      const viewports = viewportLabels.map(parseViewport);
      for (const viewport of viewports) {
        const initialCardPageTick = options.fixture === "briefing-pages" || options.fixture === "briefing-single-page" ? 0 : null;
        const first = await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, options.fixture, initialCardPageTick), scenario, viewport, outDir, rotationTick: 0, cardPageTick: initialCardPageTick, assertTable: !options.report, fixture: options.fixture });
        results.push(first);
        if (options.fixture === "briefing-pages") {
          // Deterministically drive the real page coordinator through every
          // resolved briefing page, then prove the no-footer one-page branch
          // on its own live browser fixture.
          for (let pageTick = 1; pageTick < BRIEFING_PAGING_PAGE_COUNT; pageTick += 1) {
            results.push(await capture({
              chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, options.fixture, pageTick), scenario, viewport, outDir,
              rotationTick: 0, cardPageTick: pageTick, assertTable: !options.report, fixture: options.fixture,
            }));
          }
          results.push(await capture({
            chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, "briefing-single-page", 0), scenario, viewport, outDir,
            rotationTick: 0, cardPageTick: 0, assertTable: !options.report, fixture: "briefing-single-page",
          }));
        }
        const rotationKeys = (first.diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
        if (first.diagnostics["data-ladder-stage"] === "3") {
          for (let rotationTick = 1; rotationTick < rotationKeys.length; rotationTick += 1) {
            results.push(await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, rotationTick, options.fixture), scenario, viewport, outDir, rotationTick, assertTable: !options.report, fixture: options.fixture }));
          }
        }
      }
    }
    const cells = results.filter((result) => result.rotationTick === 0).map((result) => ({
      scenario: result.scenario, viewport: result.viewport, match: result.mismatches.length === 0,
      mismatches: result.mismatches, diagnostics: result.diagnostics, geometry: result.geometry,
    }));
    process.stdout.write(`${JSON.stringify(options.report ? { outDir, cells } : { outDir, results }, null, 2)}\n`);
  } finally {
    // A SIGTERM-ed Chrome may still be flushing its profile while the recursive
    // rm walks it, surfacing ENOTEMPTY on macOS. Retry briefly, then leave the
    // stray profile behind rather than failing an otherwise-green run.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) process.stderr.write(`profile cleanup failed, leaving ${profileDir}: ${error}\n`);
        else await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    }
    if (staticServer != null) await staticServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
