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
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  process.stderr.write("Usage: node scripts/capture-legacy-standby.mjs [--report] [--suite design-alignment] [--write-baseline PATH|--baseline-report PATH] [--assert-from PATH] [--fixture overflow|overlap|rotation|cluster|cluster-calm|tornado-pages|tornado-aggregate|tornado-clip|tornado-epoch-release|recent-quakes-narrow|attention-visibility-standby|attention-visibility-emergency|attention-visibility-reduced-motion|briefing-pages|briefing-single-page] [--url URL] [--scenario quiet|4|7|max|max-floodWide] [--viewport WIDTHxHEIGHT] [--out-dir PATH]\n");
  process.exitCode = 2;
}

export function parseCaptureArgs(argv) {
  const result = { url: null, scenarios: [], viewports: [], outDir: null, report: false, fixture: null, suite: null, writeBaseline: null, baselineReport: null, assertFrom: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--url" || argument === "--scenario" || argument === "--viewport" || argument === "--out-dir" || argument === "--fixture" || argument === "--suite" || argument === "--write-baseline" || argument === "--baseline-report" || argument === "--assert-from") {
      if (value == null) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--url") result.url = value;
      if (argument === "--scenario") result.scenarios.push(value);
      if (argument === "--viewport") result.viewports.push(value);
      if (argument === "--out-dir") result.outDir = value;
      if (argument === "--fixture") result.fixture = value;
      if (argument === "--suite") result.suite = value;
      if (argument === "--write-baseline") result.writeBaseline = value;
      if (argument === "--baseline-report") result.baselineReport = value;
      if (argument === "--assert-from") result.assertFrom = value;
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
        const forecastCards = [...document.querySelectorAll('[data-weather-warning-forecast-card]')]
          .map((card) => {
            const shelf = card.closest('.measure-shelf, .center-measure-shelf');
            const atom = card.querySelector('[data-forecast-atom]');
            const footer = card.querySelector('[data-card-page-footer]');
            return {
              shelf: shelf != null,
              surface: card.closest('[data-layout-motion-card]')?.getAttribute('data-layout-motion-card') ?? null,
              page: card.getAttribute('data-card-page') ?? '',
              card: measure(card),
              header: measure(card.querySelector('.standby-card-header')),
              atom: measure(atom),
              footer: measure(footer),
              atomFooterOverlap: overlap(atom, footer),
              periodCount: card.querySelectorAll('[data-forecast-period]').length,
              continuation: card.querySelector('.continuation')?.textContent ?? '',
            };
          });
        const standbyHeaders = [...document.querySelectorAll('.standby-card-header')].map((header) => {
          const outer = header.closest('.weather-card, .forecast-card, .briefing-card, .heat-card, .flood-card, .flood-wide-card, .typhoon-card, .volcano-card, .quake-card, .quake-replay-card, .tsunami-banner');
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
        return { heat: measure(pick('.heat-card')), tsunamiBanner: measure(pick('.tsunami-banner')), panels, briefingCards, forecastCards, standbyHeaders };
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
    "data-weather-warning-forecast-page", "data-weather-warning-forecast-page-keys", "data-weather-warning-forecast-page-identities",
    "data-weather-warning-forecast-page-host", "data-weather-warning-forecast-page-mode",
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
    const rotationKeys = scenario === "max"
      ? "weather,weatherWarningForecast,flood,typhoon,volcano,heat"
      : "weather,flood,typhoon,volcano,heat";
    expectEqual(diagnostics["data-rotation-keys"], rotationKeys, `960px scenario-${scenario} rotation set (§5)`);
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

function assertForecastContinuationGeometry(geometry, diagnostics) {
  if (diagnostics["data-rotation-active-key"] !== "weatherWarningForecast") return;
  const cards = geometry?.forecastCards ?? [];
  const visible = cards.filter((entry) => !entry.shelf
    && entry.card?.clientWidth > 0 && entry.card?.clientHeight > 0);
  if (visible.length !== 1) throw new Error(`forecast continuation surface missing: ${JSON.stringify({ visible: visible.length, cards })}`);
  const entry = visible[0];
  const fits = (box) => box != null && box.clientWidth > 0 && box.clientHeight > 0
    && box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
  if (!fits(entry.card) || !fits(entry.header) || !fits(entry.atom) || !fits(entry.footer)) {
    throw new Error(`forecast continuation containment failed: ${JSON.stringify(entry)}`);
  }
  if (!/^\d+\/32$/.test(entry.page) || entry.periodCount < 1 || entry.periodCount > 4
    || entry.atomFooterOverlap > 0 || !/^続き \d+\/32$/.test(entry.continuation)) {
    throw new Error(`forecast continuation contract failed: ${JSON.stringify(entry)}`);
  }
  expectEqual(diagnostics["data-weather-warning-forecast-page"], entry.page, "forecast page diagnostic");
  expectEqual(diagnostics["data-weather-warning-forecast-page-mode"], "logical", "forecast page mode");
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
  "1920x1080": { stage: "1", rotationKeys: "", typhoonVariant: "compact", floodForm: "card", floodPage: "1/3", floodPageKeys: '["大淀川","五ヶ瀬川","一ツ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫危険情報|五ヶ瀬川|0|code:8303040003","氾濫警戒情報|一ツ瀬川|0|code:8303040005"]', floodPageFooter: "true", floodVisibleCount: "2", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 24, n: 0 } } }, surplus: "21" },
  "1280x720": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", typhoonVariant: "compact", floodForm: "card", floodPage: "1/2", floodPageKeys: '["大淀川","五ヶ瀬川"]', floodPageIdentities: '["氾濫発生情報|大淀川|0|code:8303040001","氾濫危険情報|五ヶ瀬川|0|code:8303040003"]', floodPageFooter: "true", floodVisibleCount: "0", floodRotationVisibleCount: "2", floodInfeasible: "false", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 3, n: 21 } } }, surplus: "0" },
};

// §5 / §11.1 fixed tables. --report emits this comparison without mutating
// either source of truth, so a newly measured table needs an explicit ruling.
const TABLE_EXPECTATIONS = {
  quiet: { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "0", rotationKeys: "", ...FLOOD_NONE } },
  "4": { "1920x1080": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1512x982": { stage: "0", rotationKeys: "", ...FLOOD_NONE }, "1280x720": { stage: "2", rotationKeys: "", ...FLOOD_NONE }, "960x620": { stage: "3", rotationKeys: "weather,volcano,heat", ...FLOOD_NONE } },
  "7": { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1280x720": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
  max: { "1920x1080": { stage: "1", rotationKeys: "", ...FLOOD_CARD_TWO }, "1512x982": { stage: "2", rotationKeys: "", ...FLOOD_CARD_ONE }, "1280x720": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" }, "960x620": { stage: "3", rotationKeys: "weather,weatherWarningForecast,flood,typhoon,volcano,heat", ...FLOOD_CARD_ONE, floodVisibleCount: "0" } },
};
// §11.1 C, keyed independently of the §5 ladder table. Keeping the measured
// payload here makes --report reject a stage match with stale expansion data.
const UTIL_EXPECTATIONS = {
  // In §11.1's human table "−（不在）" is encoded as the always-emitted
  // diagnostic value "none"; absence is never represented by a missing attr.
  "4": { "1920x1080": ["none", "none", 7, 0, 12, 0, 13, "false"], "1512x982": ["none", "none", 7, 0, 12, 0, 13, "false"], "1280x720": ["none", "none", 7, 0, 12, 0, 13, "false"], "960x620": ["none", "none", 7, 0, 2, 10, 3, "false"] },
  "7": { "1920x1080": ["full", "card", 7, 0, 12, 0, 14, "false"], "1512x982": ["compact", "card", 7, 0, 12, 0, 13, "false"], "1280x720": ["compact", "card", 4, 3, 2, 10, 0, "false"], "960x620": ["compact", "card", 4, 3, 2, 10, 0, "false"] },
  // The forecast card is a fixed-column member before stage 3. Its measured
  // height consumes the former typhoon/quake expansion surplus at wide cells.
  max: { "1920x1080": ["compact", "card", 4, 3, 24, 0, 21, "false"], "1512x982": ["compact", "card", 4, 3, 24, 0, 21, "false"], "1280x720": ["compact", "card", 4, 3, 3, 21, 0, "false"], "960x620": ["compact", "card", 4, 3, 3, 21, 0, "false"] },
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
  const rotationActiveKey = diagnostics["data-rotation-active-key"] ?? "";
  const rotationKeys = (diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
  // Stage 3 keeps every logical pager registered while rendering one rotation
  // member. Visibility counts therefore follow the active host, rather than
  // the tick-0 table cell used to describe the stable partition itself.
  if (fixtureExpected == null && rotationKeys.length > 0) {
    expected.floodVisibleCount = rotationActiveKey === "flood" && baseExpected?.floodForm === "card"
      ? (baseExpected.floodRotationVisibleCount ?? FLOOD_CARD_ONE.floodVisibleCount)
      : "0";
    expected.tornadoVisibleCount = rotationActiveKey === "weather"
      ? tornadoExpectation(scenario, viewport).tornadoVisibleCount
      : "0";
  }
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
  const forecastContinuationCapture = scenario === "max" && viewport.label === "960x620";
  if (attentionFixture || fixture === "briefing-pages" || fixture === "briefing-single-page" || forecastContinuationCapture || process.argv.includes("--report")) {
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
    if (attentionGeometry != null) assertForecastContinuationGeometry(attentionGeometry, diagnostics);
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

const DESIGN_ALIGNMENT_CANDIDATE_COUNTS = {
  tsunami: 1, quake: 1, weather: 1, weatherWarningForecast: 1, briefing: 1,
  flood: 1, typhoon: 1, volcano: 1, heat: 1,
};
const DESIGN_ALIGNMENT_RIDER_COUNTS = { tornado: 1, longPeriod: 1, nankaiTrough: 1 };
export const DESIGN_ALIGNMENT_MAX_PLAN = {
  viewport: "1280x720",
  stage: 3,
  compressed: true,
  placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
  placementRight: ["weather"],
  placementCenter: ["flood"],
  rotationKeys: ["typhoon", "volcano", "heat"],
  typhoonVariant: "compact",
  rotationOmittedCount: 0,
  captureTickCount: 6,
};
export const DESIGN_ALIGNMENT_COMPRESSED_PLANS = {
  "1280x720": {
    stage: 3,
    placementLeft: ["tsunami", "quake", "weatherWarningForecast"],
    placementRight: ["briefing"],
    placementCenter: ["weather"],
    rotationKeys: ["flood", "typhoon", "volcano", "heat"],
    typhoonVariant: "compact",
    briefingCaptureTick: 0,
    forecastCaptureTick: 0,
    typhoonCaptureTick: 1,
  },
  "960x620": {
    stage: 3,
    placementLeft: ["tsunami", "quake"],
    placementRight: [],
    placementCenter: [],
    rotationKeys: ["weather", "weatherWarningForecast", "briefing", "flood", "typhoon", "volcano", "heat"],
    typhoonVariant: "compact",
    briefingCaptureTick: 2,
    forecastCaptureTick: 1,
    typhoonCaptureTick: 4,
  },
};
export const DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE = {
  weatherWarningForecast: { periodCount: 128, atomCount: 32, maxPeriodsPerAtom: 4, multipleAtomFooter: true },
  briefingFacts: [
    { locationName: "さいたま市", approximation: "approx", value: 100, unit: "mm", visibleText: "約100mm", at: "2026-07-07T14:20:00+09:00", duration: "1時間" },
    { locationName: "美幌町", approximation: "atLeast", value: 120, unit: "mm", visibleText: "120mm以上", at: "2026-07-07T14:25:00+09:00", duration: "1時間" },
  ],
  floodRiverCount: 3,
  typhoon: {
    count: 2, probabilityTyphoonKey: "TC2618", maxFiveDayProbability: 80, activePrefectureCount: 8,
    topPrefectures: [["東京都", 80], ["神奈川県", 70], ["千葉県", 60], ["埼玉県", 50], ["茨城県", 40], ["栃木県", 30]],
    worstArea: ["東京地方", 80],
  },
  volcanoCount: 5,
  heatAreaCount: 30,
};

function designAlignmentEntry(scenario, viewport, rotationTick = null, cardPageTick = null, query = null) {
  return { scenario, viewport, rotationTick, cardPageTick, query };
}

export const DESIGN_ALIGNMENT_MANIFEST = [
  ...[0, 1, 2].map((page) => designAlignmentEntry("standby-briefing-design-alignment", "1280x720", null, page)),
  designAlignmentEntry("standby-vpwp50-forecast", "1280x720", null, 0),
  designAlignmentEntry("standby-vpta50-probability-muted", "1280x720", null, 0),
  designAlignmentEntry("standby-vpta50-probability-normal", "1280x720", null, 0),
  ...["1280x720", "960x620"].flatMap((viewport) => {
    const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
    return [
      ...plan.rotationKeys.map((_, tick) => designAlignmentEntry("standby-design-alignment-compressed", viewport, tick, 0)),
      designAlignmentEntry("standby-design-alignment-compressed", viewport, plan.briefingCaptureTick, 1),
      designAlignmentEntry("standby-design-alignment-compressed", viewport, plan.briefingCaptureTick, 2),
    ];
  }),
  ...Array.from({ length: DESIGN_ALIGNMENT_MAX_PLAN.captureTickCount }, (_, tick) => designAlignmentEntry("legacy-standby-gate", DESIGN_ALIGNMENT_MAX_PLAN.viewport, tick, 0, "gateScenario=max")),
];

function manifestKey(value) {
  const viewport = typeof value.viewport === "string" ? value.viewport : value.viewport?.label;
  return [value.scenario, viewport, value.rotationTick ?? "-", value.cardPageTick ?? "-", value.query ?? ""].join("|");
}

export function normalizeDesignAlignmentUrl(value) {
  const url = new URL(value);
  return `${url.pathname}${url.search}${url.hash}`;
}

function designAlignmentUrl(baseUrl, entry) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  if (entry.query != null) {
    for (const [key, value] of new URLSearchParams(entry.query)) url.searchParams.set(key, value);
  }
  if (entry.rotationTick != null) url.searchParams.set("rotationTick", String(entry.rotationTick));
  if (entry.cardPageTick != null) url.searchParams.set("cardPageTick", String(entry.cardPageTick));
  url.hash = entry.scenario;
  return url.toString();
}

export const DESIGN_ALIGNMENT_REPORT_EXPRESSION = String.raw`(async () => {
  await (document.fonts?.ready ?? Promise.resolve());
  const root = document.querySelector('.standby');
  const preview = document.querySelector('main.preview-screen');
  if (root == null || preview == null) return { ready: false, reason: 'standby root missing' };
  const all = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const numeric = (value) => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : null;
  };
  const attrNumber = (name) => numeric(root.getAttribute(name));
  const splitAttr = (name) => (root.getAttribute(name) ?? '').split(',').filter(Boolean);
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const compactText = (value) => clean(value).replace(/\s+/g, '');
  const rect = (node) => {
    if (node == null) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
  };
  const lineCount = (node) => {
    if (node == null) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = [];
    for (const box of range.getClientRects()) {
      if (box.width <= 0 || box.height <= 0) continue;
      const row = rows.find((candidate) => box.top < candidate.bottom - 1 && box.bottom > candidate.top + 1);
      if (row == null) rows.push({ top: box.top, bottom: box.bottom });
      else {
        row.top = Math.min(row.top, box.top);
        row.bottom = Math.max(row.bottom, box.bottom);
      }
    }
    return rows.length;
  };
  const measure = (node) => {
    if (node == null) return null;
    const style = getComputedStyle(node);
    return {
      rect: rect(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      overflowX: Math.max(0, node.scrollWidth - node.clientWidth),
      overflowY: Math.max(0, node.scrollHeight - node.clientHeight),
      borderTop: numeric(style.borderTopWidth) ?? 0, borderRight: numeric(style.borderRightWidth) ?? 0,
      borderBottom: numeric(style.borderBottomWidth) ?? 0, borderLeft: numeric(style.borderLeftWidth) ?? 0,
    };
  };
  const textMeasure = (node) => node == null ? null : {
    ...measure(node), text: clean(node.textContent), compactText: compactText(node.textContent), lineCount: lineCount(node),
    fontSize: numeric(getComputedStyle(node).fontSize), fontWeight: getComputedStyle(node).fontWeight,
    fontVariantNumeric: getComputedStyle(node).fontVariantNumeric,
  };
  const overlap = (left, right) => {
    if (left == null || right == null) return 0;
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  };
  const painted = (node) => node != null && node.closest('[hidden], [aria-hidden="true"], [inert]') == null
    && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  const liveHosts = all('[data-layout-motion-card]', root).filter(painted);
  const componentSelectors = {
    tsunami: '.tsunami-banner', quake: '.quake-card', weather: '.weather-card',
    weatherWarningForecast: '[data-weather-warning-forecast-card]', briefing: '[data-briefing-card]',
    flood: '.flood-card, .flood-wide-card', typhoon: '.typhoon-card', volcano: '.volcano-card', heat: '.heat-card',
  };
  const componentIn = (parent, kind) => parent?.matches?.(componentSelectors[kind]) ? parent : parent?.querySelector?.(componentSelectors[kind]) ?? null;
  const liveComponent = (kind) => {
    for (const host of liveHosts) {
      const key = (host.getAttribute('data-layout-motion-card') ?? '').split(':')[0];
      if (key === kind) return componentIn(host, kind);
    }
    return null;
  };
  const sideShelf = root.querySelector(':scope > .measure-shelf');
  const compactMeasureItems = sideShelf == null ? [] : all(':scope > .measure-item[data-measure-variant="compact"]', sideShelf);
  const candidateCounts = {};
  const measurementWidths = {};
  for (const item of compactMeasureItems) {
    const kind = Object.keys(componentSelectors).find((candidate) => componentIn(item, candidate) != null) ?? null;
    if (kind == null) continue;
    candidateCounts[kind] = (candidateCounts[kind] ?? 0) + 1;
    measurementWidths[kind] = componentIn(item, kind).getBoundingClientRect().width;
  }
  const visibleCards = liveHosts.map((host) => {
    const token = host.getAttribute('data-layout-motion-card') ?? '';
    const boundary = token.lastIndexOf(':');
    const key = boundary < 0 ? token : token.slice(0, boundary);
    const surface = boundary < 0 ? '' : token.slice(boundary + 1);
    const component = componentIn(host, key);
    return { key, surface, host: measure(host), component: measure(component) };
  });
  const fragment = (node) => textMeasure(node);
  const briefingCard = liveComponent('briefing');
  const briefing = briefingCard == null ? null : {
    page: briefingCard.getAttribute('data-card-page') ?? '',
    pageKeys: JSON.parse(briefingCard.getAttribute('data-card-page-keys') ?? '[]'),
    pageIdentities: JSON.parse(briefingCard.getAttribute('data-card-page-identities') ?? '[]'),
    card: measure(briefingCard),
    grids: all('.briefing-fact-grid', briefingCard).map((grid) => {
      const body = grid.closest('.body');
      const gridStyle = getComputedStyle(grid);
      const stats = all(':scope > .briefing-fact-stat', grid).map((stat) => {
        const role = stat.hasAttribute('data-briefing-precipitation-location') ? 'location'
          : stat.hasAttribute('data-briefing-precipitation-amount') ? 'amount'
          : stat.hasAttribute('data-briefing-precipitation-time') ? 'time'
          : stat.hasAttribute('data-briefing-precipitation-duration') ? 'duration' : 'unknown';
        const value = stat.querySelector('.briefing-fact-value');
        const token = stat.querySelector('.briefing-fact-token');
        return {
          role, stat: measure(stat), gap: numeric(getComputedStyle(stat).gap),
          label: clean(stat.querySelector('.briefing-fact-label')?.textContent), value: textMeasure(value),
          numberUnit: token == null ? null : { wrapper: textMeasure(token), value: fragment(token.querySelector('.nu-value')), unit: fragment(token.querySelector('.nu-unit')) },
        };
      });
      const location = stats.find((stat) => stat.role === 'location')?.value?.text ?? '';
      const amount = stats.find((stat) => stat.role === 'amount')?.value?.compactText ?? '';
      return {
        location, amount,
        approximation: amount.startsWith('約') ? 'approx' : amount.endsWith('以上') ? 'atLeast' : null,
        body: measure(body), bodyPadding: body == null ? null : {
          top: numeric(getComputedStyle(body).paddingTop), right: numeric(getComputedStyle(body).paddingRight),
          bottom: numeric(getComputedStyle(body).paddingBottom), left: numeric(getComputedStyle(body).paddingLeft),
        },
        grid: measure(grid), gridTemplateColumns: gridStyle.gridTemplateColumns,
        rowGap: numeric(gridStyle.rowGap), columnGap: numeric(gridStyle.columnGap),
        margin: { top: numeric(gridStyle.marginTop), right: numeric(gridStyle.marginRight), bottom: numeric(gridStyle.marginBottom), left: numeric(gridStyle.marginLeft) },
        stats,
      };
    }),
  };
  const forecastCard = liveComponent('weatherWarningForecast');
  const forecast = forecastCard == null ? null : (() => {
    const header = forecastCard.querySelector('.standby-card-header');
    const atom = forecastCard.querySelector('[data-forecast-atom]');
    const footer = forecastCard.querySelector('[data-card-page-footer]');
    const periods = forecastCard.querySelector('.periods');
    const headerStyle = header == null ? null : getComputedStyle(header);
    const cardStyle = getComputedStyle(forecastCard);
    return {
      page: forecastCard.getAttribute('data-card-page') ?? '',
      pageKeys: JSON.parse(forecastCard.getAttribute('data-card-page-keys') ?? '[]'),
      pageIdentities: JSON.parse(forecastCard.getAttribute('data-card-page-identities') ?? '[]'),
      identity: atom?.getAttribute('data-forecast-atom') ?? null,
      card: measure(forecastCard), header: measure(header), atom: measure(atom), footer: measure(footer), periods: measure(periods),
      headerPadding: headerStyle == null ? null : {
        top: numeric(headerStyle.paddingTop), right: numeric(headerStyle.paddingRight),
        bottom: numeric(headerStyle.paddingBottom), left: numeric(headerStyle.paddingLeft),
      },
      periodGap: periods == null ? null : numeric(getComputedStyle(periods).rowGap),
      periodKeys: all('[data-forecast-period]', forecastCard).map((period) => period.getAttribute('data-forecast-period')),
      periodCount: all('[data-forecast-period]', forecastCard).length,
      atomFooterOverlap: overlap(atom, footer),
      naturalHeight: forecastCard.scrollHeight + (numeric(cardStyle.borderTopWidth) ?? 0) + (numeric(cardStyle.borderBottomWidth) ?? 0),
    };
  })();
  const resolveCustomFontWeight = (context) => {
    if (context == null) return null;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-weight:var(--num-weight)';
    context.append(probe);
    const result = getComputedStyle(probe).fontWeight;
    probe.remove();
    return result;
  };
  const resolveRoleMuted = () => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--role-muted)';
    root.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  };
  const probabilityRole = (role, context, label) => {
    if (context == null) return null;
    const probabilityNumber = context.matches?.('.probability-number') ? context : context.querySelector('.probability-number');
    const nuValue = probabilityNumber?.querySelector('.nu-value') ?? null;
    const nuUnit = probabilityNumber?.querySelector('.nu-unit') ?? null;
    const legacyMatch = compactText(context.textContent).match(/(\d+)%/);
    return {
      role, label, legacyNode: textMeasure(context), probabilityNumber: textMeasure(probabilityNumber),
      nuValue: fragment(nuValue), nuUnit: fragment(nuUnit),
      value: nuValue == null ? (legacyMatch == null ? null : Number(legacyMatch[1])) : Number(clean(nuValue.textContent)),
      unit: nuUnit == null ? (legacyMatch == null ? null : '%') : clean(nuUnit.textContent),
    };
  };
  const typhoonCard = liveComponent('typhoon');
  const typhoon = typhoonCard == null ? null : (() => {
    const header = typhoonCard.querySelector('.standby-card-header');
    const headerStyle = header == null ? null : getComputedStyle(header);
    const compact = typhoonCard.classList.contains('compact');
    const roles = [];
    if (compact) {
      const summary = typhoonCard.querySelector('.probability-compact-summary');
      roles.push(probabilityRole('maximum', summary?.querySelector(':scope > .probability-number, :scope > strong') ?? null, 'maximum'));
      for (const prefecture of all('.probability-prefectures > span:not(.probability-omitted)', typhoonCard)) {
        roles.push(probabilityRole('prefecture', prefecture, clean(prefecture.childNodes[0]?.textContent)));
      }
    } else {
      roles.push(probabilityRole('maximum', typhoonCard.querySelector('.probability-maximum'), 'maximum'));
      for (const prefecture of all('.probability-prefecture-list > li', typhoonCard)) {
        roles.push(probabilityRole('prefecture', prefecture, clean(prefecture.firstElementChild?.textContent)));
      }
    }
    const worst = typhoonCard.querySelector('.probability-worst');
    roles.push(probabilityRole('worst', worst, clean(worst?.textContent).replace(/\s*\d+%.*$/, '')));
    const styleAttribute = header?.getAttribute('style') ?? '';
    return {
      scenario: window.location.hash.replace(/^#/, ''),
      displayMode: compact ? 'compact' : 'full', card: measure(typhoonCard), resolvedNumWeight: resolveCustomFontWeight(typhoonCard),
      header: header == null ? null : {
        node: measure(header), className: header.className, style: styleAttribute,
        customProperties: {
          container: header.style.getPropertyValue('--standby-header-container'),
          on: header.style.getPropertyValue('--standby-header-on'),
          band: header.style.getPropertyValue('--standby-header-band'),
        },
        background: headerStyle.backgroundColor, color: headerStyle.color,
        bandWidth: numeric(headerStyle.borderBottomWidth), roleMuted: resolveRoleMuted(),
      },
      roles: roles.filter(Boolean),
    };
  })();
  const parsePreviewJson = (name) => {
    const raw = preview.getAttribute(name);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return { parseError: raw }; }
  };
  return {
    ready: document.fonts?.status === 'loaded', settled: root.getAttribute('data-measurement-settled') === 'true',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    rootFontSize: numeric(getComputedStyle(root).fontSize),
    layout: {
      ladderStage: attrNumber('data-ladder-stage'), measurementGeometryStage: attrNumber('data-measurement-geometry-stage'),
      compressed: root.classList.contains('ladder-compressed'), unresolved: root.getAttribute('data-layout-unresolved'),
      nonconverged: root.getAttribute('data-measurement-nonconverged'),
      placementLeft: splitAttr('data-placement-left'), placementRight: splitAttr('data-placement-right'), placementCenter: splitAttr('data-placement-center'),
      rotationKeys: splitAttr('data-rotation-keys'), rotationOmittedCount: attrNumber('data-rotation-omitted-count'),
      rotationActiveKey: root.getAttribute('data-rotation-active-key') ?? '', rotationPosition: root.getAttribute('data-rotation-position') ?? '',
      typhoonVariant: root.getAttribute('data-typhoon-variant') ?? '',
      cardOverflowKeys: splitAttr('data-card-overflow-keys'), readableOverflowKeys: splitAttr('data-page-viewport-overflow-keys'),
      visibleCards, candidateCounts, measurementWidths,
      sideMeasureShelfWidth: attrNumber('data-side-measure-shelf-rect-width-px'),
    },
    riderReserveCounts: parsePreviewJson('data-design-alignment-rider-reserve-counts'),
    payloadSignature: parsePreviewJson('data-design-alignment-payload-signature'),
    briefing, forecast, typhoon,
  };
})()`;

async function captureDesignAlignmentPage({ chrome, profileDir, url, viewport, outDir, entry }) {
  const suffix = `r${entry.rotationTick ?? "x"}-p${entry.cardPageTick ?? "x"}`;
  const pngPath = join(outDir, `design-alignment-${entry.scenario}-${viewport.label}-${suffix}.png`);
  const browserProfile = join(profileDir, `.suite-${entry.scenario}-${viewport.label}-${suffix}`);
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--remote-debugging-pipe", `--user-data-dir=${browserProfile}`, `--window-size=${viewport.width},${viewport.height}`, url,
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = createCdpPipe(child);
  try {
    let page = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const targets = await cdp.command("Target.getTargets");
        page = targets.targetInfos.find((candidate) => candidate.type === "page" && candidate.url === url)
          ?? targets.targetInfos.find((candidate) => candidate.type === "page") ?? null;
      } catch {
        // Chrome has not opened the target yet.
      }
      if (page != null) break;
      await wait(100);
    }
    if (page == null) throw new Error(`design-alignment ${manifestKey(entry)}: page target did not become ready`);
    const attached = await cdp.command("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await cdp.command("Page.enable", {}, attached.sessionId);
    await cdp.command("Runtime.enable", {}, attached.sessionId);
    await cdp.command("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    }, attached.sessionId);
    const evaluate = async () => {
      const result = await cdp.command("Runtime.evaluate", {
        awaitPromise: true, returnByValue: true, expression: DESIGN_ALIGNMENT_REPORT_EXPRESSION,
      }, attached.sessionId);
      if (result.exceptionDetails != null) throw new Error(`design-alignment browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    await wait(750);
    let previous = null;
    let geometry = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate = await evaluate();
      const serialized = JSON.stringify(candidate);
      if (candidate?.ready && candidate?.settled && previous === serialized) {
        geometry = candidate;
        break;
      }
      previous = candidate?.ready && candidate?.settled ? serialized : null;
      await wait(400);
    }
    if (geometry == null) throw new Error(`design-alignment ${manifestKey(entry)}: geometry did not settle`);
    const screenshot = await cdp.command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, attached.sessionId);
    const confirmed = await evaluate();
    if (JSON.stringify(confirmed) !== JSON.stringify(geometry)) {
      throw new Error(`design-alignment ${manifestKey(entry)}: DOM state changed while capturing screenshot`);
    }
    await rm(pngPath, { force: true });
    await writeFile(pngPath, Buffer.from(screenshot.data, "base64"));
    assertCompletePng(await readFile(pngPath));
    return {
      manifestKey: manifestKey(entry), scenario: entry.scenario, viewport: { label: viewport.label, width: viewport.width, height: viewport.height },
      rotationTick: entry.rotationTick, cardPageTick: entry.cardPageTick, query: entry.query,
      urlIdentity: normalizeDesignAlignmentUrl(url), pngPath, geometry,
    };
  } finally {
    cdp.close();
    child.kill("SIGTERM");
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value != null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertDeepEqual(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertDesignAlignmentApprox(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) throw new Error(`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
}

function assertBox(box, label) {
  if (box == null) throw new Error(`${label}: missing box`);
  for (const key of ["clientWidth", "scrollWidth", "clientHeight", "scrollHeight", "overflowX", "overflowY"]) {
    if (!Number.isFinite(box[key])) throw new Error(`${label}.${key}: non-finite geometry`);
  }
  if (box.rect == null) throw new Error(`${label}.rect: missing`);
  for (const key of ["x", "y", "left", "right", "top", "bottom", "width", "height"]) {
    if (!Number.isFinite(box.rect[key])) throw new Error(`${label}.rect.${key}: non-finite geometry`);
  }
}

function assertNoOverflow(box, label) {
  assertBox(box, label);
  if (box.overflowX > 1 || box.overflowY > 1) throw new Error(`${label}: client/scroll overflow ${box.overflowX}x${box.overflowY}`);
}

export function isDesignAlignmentSingleVisualLine(node, fragments = []) {
  if (node?.lineCount === 1) return true;
  const fragmentHeight = Math.max(...fragments.map((fragment) => fragment?.rect?.height).filter(Number.isFinite), 0);
  return Number.isFinite(node?.rect?.height) && fragmentHeight > 0 && node.rect.height <= fragmentHeight + 1;
}

function findRecords(records, scenario, viewport) {
  return records.filter((record) => record.scenario === scenario && record.viewport.label === viewport);
}

export function assertDesignAlignmentManifestCoverage(records) {
  const expected = DESIGN_ALIGNMENT_MANIFEST.map(manifestKey);
  const actual = records.map((record) => record.manifestKey ?? manifestKey(record));
  assertDeepEqual(actual, expected, "design-alignment manifest keys");
  if (new Set(actual).size !== actual.length) throw new Error("design-alignment manifest contains duplicate keys");
}

export function assertDesignAlignmentBaselineStructure(records) {
  assertDesignAlignmentManifestCoverage(records);
  for (const record of records) assertRequiredReport(record, { allowLegacyTyphoonNodes: true });
  for (const viewport of ["1280x720", "960x620"]) {
    const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
    const cells = findRecords(records, "standby-design-alignment-compressed", viewport);
    const tickZeroPages = cells.filter((record) => record.cardPageTick === 0);
    assertDeepEqual(tickZeroPages.map((record) => record.rotationTick), [...Array(plan.rotationKeys.length).keys()], `${viewport} baseline rotation tick coverage`);
    for (const record of cells) {
      const layout = record.geometry.layout;
      assertDesignAlignmentCompressedStage(layout, plan, `${record.manifestKey}: baseline`);
    }
  }
  const maxCells = findRecords(records, "legacy-standby-gate", DESIGN_ALIGNMENT_MAX_PLAN.viewport);
  assertDeepEqual(maxCells.map((record) => record.rotationTick), [...Array(DESIGN_ALIGNMENT_MAX_PLAN.captureTickCount).keys()], "baseline max rotation tick coverage");
  for (const record of maxCells) {
    const layout = record.geometry.layout;
    if (layout.ladderStage < 2 || layout.measurementGeometryStage < 2 || layout.compressed !== true) throw new Error(`${record.manifestKey}: baseline max compressed stage contract failed`);
  }
  assertBaselineForecastCoverage(records);
  assertBaselineTyphoonCoverage(records);
}

function assertRequiredReport(record, { allowLegacyTyphoonNodes = false } = {}) {
  const report = record.geometry;
  if (report == null || report.ready !== true || report.settled !== true) throw new Error(`${record.manifestKey}: font/layout not ready`);
  assertDesignAlignmentApprox(report.rootFontSize, 16, 0.1, `${record.manifestKey} root font-size`);
  if (report.viewport.width !== record.viewport.width || report.viewport.height !== record.viewport.height) throw new Error(`${record.manifestKey}: viewport mismatch`);
  for (const key of ["ladderStage", "measurementGeometryStage", "rotationOmittedCount", "sideMeasureShelfWidth"]) {
    if (!Number.isFinite(report.layout[key])) throw new Error(`${record.manifestKey} layout.${key}: missing/non-finite`);
  }
  for (const key of ["placementLeft", "placementRight", "placementCenter", "rotationKeys", "cardOverflowKeys", "readableOverflowKeys", "visibleCards"]) {
    if (!Array.isArray(report.layout[key])) throw new Error(`${record.manifestKey} layout.${key}: missing`);
  }
  for (const visible of report.layout.visibleCards) {
    assertBox(visible.host, `${record.manifestKey} visible ${visible.key}:${visible.surface} host`);
    if (visible.component != null) assertBox(visible.component, `${record.manifestKey} visible ${visible.key}:${visible.surface} component`);
  }
  if (report.layout.unresolved !== "false" || report.layout.nonconverged !== "false") throw new Error(`${record.manifestKey}: unresolved/nonconverged layout`);
  if (report.layout.cardOverflowKeys.length !== 0 || report.layout.readableOverflowKeys.length !== 0) throw new Error(`${record.manifestKey}: generic containment failed`);
  const activeKind = record.scenario === "standby-design-alignment-compressed" || record.scenario === "legacy-standby-gate"
    ? report.layout.rotationActiveKey : record.scenario === "standby-briefing-design-alignment" ? "briefing"
      : record.scenario === "standby-vpwp50-forecast" ? "weatherWarningForecast"
        : record.scenario.startsWith("standby-vpta50-") ? "typhoon" : null;
  if (activeKind === "briefing") {
    if (report.briefing == null || !Array.isArray(report.briefing.grids) || !Array.isArray(report.briefing.pageKeys) || !Array.isArray(report.briefing.pageIdentities)) throw new Error(`${record.manifestKey}: required Briefing report fields missing`);
    assertBox(report.briefing.card, `${record.manifestKey} briefing card`);
    for (const [gridIndex, grid] of report.briefing.grids.entries()) {
      assertBox(grid.body, `${record.manifestKey} briefing grid ${gridIndex} body`);
      assertBox(grid.grid, `${record.manifestKey} briefing grid ${gridIndex}`);
      if (!Array.isArray(grid.stats)) throw new Error(`${record.manifestKey}: briefing grid stats missing`);
      for (const stat of grid.stats) {
        assertBox(stat.stat, `${record.manifestKey} briefing ${stat.role} stat`);
        assertBox(stat.value, `${record.manifestKey} briefing ${stat.role} value`);
        if (stat.role === "amount" && stat.numberUnit == null) throw new Error(`${record.manifestKey}: briefing amount NumberUnit report missing`);
      }
    }
  }
  if (activeKind === "weatherWarningForecast") {
    if (report.forecast == null || !Array.isArray(report.forecast.periodKeys) || !Array.isArray(report.forecast.pageKeys) || !Array.isArray(report.forecast.pageIdentities)) throw new Error(`${record.manifestKey}: required forecast report fields missing`);
    for (const [name, box] of [["card", report.forecast.card], ["header", report.forecast.header], ["atom", report.forecast.atom], ["footer", report.forecast.footer], ["periods", report.forecast.periods]]) assertBox(box, `${record.manifestKey} forecast ${name}`);
    if (!Number.isFinite(report.forecast.naturalHeight) || !Number.isFinite(report.forecast.periodCount) || report.forecast.headerPadding == null) throw new Error(`${record.manifestKey}: forecast numeric fields missing`);
  }
  if (activeKind === "typhoon") {
    if (report.typhoon == null || report.typhoon.scenario !== record.scenario || report.typhoon.header == null || !Array.isArray(report.typhoon.roles)) throw new Error(`${record.manifestKey}: required Typhoon report fields missing`);
    assertBox(report.typhoon.card, `${record.manifestKey} typhoon card`);
    for (const role of report.typhoon.roles) {
      for (const key of ["legacyNode", "probabilityNumber", "nuValue", "nuUnit"]) {
        if (!Object.hasOwn(role, key)) throw new Error(`${record.manifestKey}: Typhoon ${role.role}.${key} key missing`);
      }
      if (role.legacyNode != null) assertBox(role.legacyNode, `${record.manifestKey} Typhoon ${role.role} legacy node`);
      for (const key of ["probabilityNumber", "nuValue", "nuUnit"]) {
        if (role[key] == null) {
          if (!allowLegacyTyphoonNodes) throw new Error(`${record.manifestKey}: Typhoon ${role.role}.${key} missing`);
        } else assertBox(role[key], `${record.manifestKey} Typhoon ${role.role} ${key}`);
      }
    }
  }
}

export function requiresDesignAlignmentWidthMatch({ key, surface }) {
  return key === "briefing" || key === "weatherWarningForecast" || surface === "right" || surface === "rotation";
}

export function assertDesignAlignmentLiveMeasurementWidths(record) {
  const layout = record.geometry?.layout;
  if (layout == null || !Array.isArray(layout.visibleCards) || layout.measurementWidths == null) throw new Error(`${record.manifestKey}: width report missing`);
  for (const visible of layout.visibleCards.filter((card) => Object.hasOwn(DESIGN_ALIGNMENT_CANDIDATE_COUNTS, card.key) && requiresDesignAlignmentWidthMatch(card))) {
    const measuredWidth = layout.measurementWidths[visible.key];
    assertDesignAlignmentApprox(visible.component?.rect?.width, measuredWidth, 1, `${record.manifestKey} ${visible.key} live/measurement width`);
  }
}

export function assertDesignAlignmentCompressedStage(layout, plan, label) {
  if (layout?.ladderStage !== plan.stage || layout?.measurementGeometryStage !== plan.stage || layout.compressed !== true) {
    throw new Error(`${label}: compressed stage contract failed; expected ladder/measurement stage ${plan.stage}`);
  }
}

function assertCompressedPlan(records, viewport) {
  const plan = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport];
  if (plan == null) throw new Error(`${viewport}: compressed plan missing`);
  const cells = findRecords(records, "standby-design-alignment-compressed", viewport);
  const expectedTicks = [...Array(plan.rotationKeys.length).keys()];
  const tickZeroPages = cells.filter((record) => record.cardPageTick === 0);
  assertDeepEqual(tickZeroPages.map((record) => record.rotationTick), expectedTicks, `${viewport} rotation tick coverage`);
  for (const record of cells) {
    const { layout } = record.geometry;
    assertDesignAlignmentCompressedStage(layout, plan, record.manifestKey);
    assertDeepEqual(layout.placementLeft, plan.placementLeft, `${record.manifestKey} left placement`);
    assertDeepEqual(layout.placementRight, plan.placementRight, `${record.manifestKey} right placement`);
    assertDeepEqual(layout.placementCenter, plan.placementCenter, `${record.manifestKey} center placement`);
    assertDeepEqual(layout.rotationKeys, plan.rotationKeys, `${record.manifestKey} rotation keys`);
    if (layout.rotationOmittedCount !== 0 || layout.typhoonVariant !== plan.typhoonVariant) throw new Error(`${record.manifestKey}: omitted rotation or Typhoon variant mismatch`);
    assertDeepEqual(layout.candidateCounts, DESIGN_ALIGNMENT_CANDIDATE_COUNTS, `${record.manifestKey} candidate counts`);
    assertDeepEqual(record.geometry.riderReserveCounts, DESIGN_ALIGNMENT_RIDER_COUNTS, `${record.manifestKey} rider/reserve counts`);
    assertDeepEqual(record.geometry.payloadSignature, DESIGN_ALIGNMENT_PAYLOAD_SIGNATURE, `${record.manifestKey} payload signature`);
    const active = plan.rotationKeys[record.rotationTick % plan.rotationKeys.length];
    if (layout.rotationActiveKey !== active || layout.rotationPosition !== `${record.rotationTick + 1}/${plan.rotationKeys.length}`) throw new Error(`${record.manifestKey}: active rotation mismatch`);
    const visibleCandidates = layout.visibleCards.filter((card) => Object.hasOwn(DESIGN_ALIGNMENT_CANDIDATE_COUNTS, card.key)).map(({ key, surface }) => ({ key, surface }));
    const expectedVisibleCount = plan.placementLeft.length + plan.placementRight.length + plan.placementCenter.length + 1;
    if (visibleCandidates.length !== expectedVisibleCount) throw new Error(`${record.manifestKey}: visible candidate count mismatch`);
    for (const [surface, expectedKeys] of [
      ["left", plan.placementLeft], ["right", plan.placementRight], ["center", plan.placementCenter], ["rotation", [active]],
    ]) {
      assertDeepEqual(visibleCandidates.filter((card) => card.surface === surface).map((card) => card.key), expectedKeys, `${record.manifestKey} visible ${surface} placement`);
    }
    assertDesignAlignmentLiveMeasurementWidths(record);
  }
}

export function assertDesignAlignmentMaxFixture(records) {
  const plan = DESIGN_ALIGNMENT_MAX_PLAN;
  const cells = findRecords(records, "legacy-standby-gate", plan.viewport);
  assertDeepEqual(cells.map((record) => record.rotationTick), [...Array(plan.captureTickCount).keys()], "max rotation tick coverage");
  for (const record of cells) {
    const { layout } = record.geometry;
    if (layout.ladderStage !== plan.stage || layout.measurementGeometryStage !== plan.stage || layout.compressed !== plan.compressed) throw new Error(`${record.manifestKey}: max stage/compressed mismatch`);
    assertDeepEqual(layout.placementLeft, plan.placementLeft, `${record.manifestKey} max left placement`);
    assertDeepEqual(layout.placementRight, plan.placementRight, `${record.manifestKey} max right placement`);
    assertDeepEqual(layout.placementCenter, plan.placementCenter, `${record.manifestKey} max center placement`);
    assertDeepEqual(layout.rotationKeys, plan.rotationKeys, `${record.manifestKey} max rotation keys`);
    if (layout.rotationOmittedCount !== plan.rotationOmittedCount || layout.typhoonVariant !== plan.typhoonVariant) throw new Error(`${record.manifestKey}: max omitted rotation or Typhoon variant mismatch`);
    const activeIndex = record.rotationTick % plan.rotationKeys.length;
    const expected = plan.rotationKeys[activeIndex];
    if (layout.rotationActiveKey !== expected || layout.rotationPosition !== `${activeIndex + 1}/${plan.rotationKeys.length}`) throw new Error(`${record.manifestKey}: max active rotation mismatch`);
    assertDesignAlignmentLiveMeasurementWidths(record);
  }
}

function statByRole(grid, role) {
  return grid.stats.find((stat) => stat.role === role);
}

function assertBriefingCaptureCoverage(records) {
  for (const [scenario, viewport, tick] of [
    ["standby-briefing-design-alignment", "1280x720", null],
    ["standby-design-alignment-compressed", "1280x720", DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].briefingCaptureTick],
    ["standby-design-alignment-compressed", "960x620", DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].briefingCaptureTick],
  ]) {
    const cells = findRecords(records, scenario, viewport);
    if (scenario === "standby-design-alignment-compressed" && viewport === "1280x720" && cells.some((record) => record.geometry.briefing == null)) {
      throw new Error(`${scenario}/${viewport}: side Briefing was not visible for every rotation tick`);
    }
    const reports = cells
      .filter((record) => scenario !== "standby-design-alignment-compressed" || record.rotationTick === tick)
      .map((record) => record.geometry.briefing).filter(Boolean);
    const facts = reports.flatMap((report) => report.grids).map(({ location, amount, approximation }) => ({ location, amount, approximation }));
    for (const expected of [
      { location: "さいたま市", amount: "約100mm", approximation: "approx" },
      { location: "美幌町", amount: "120mm以上", approximation: "atLeast" },
    ]) {
      if (!facts.some((fact) => stableJson(fact) === stableJson(expected))) throw new Error(`${scenario}/${viewport}: required precipitation fact was not captured: ${JSON.stringify(expected)}`);
    }
  }
}

function assertBaselineForecastCoverage(records) {
  for (const [scenario, viewport, tick] of [
    ["standby-vpwp50-forecast", "1280x720", null],
    ["standby-design-alignment-compressed", "1280x720", DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick],
    ["standby-design-alignment-compressed", "960x620", DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick],
  ]) {
    const cells = findRecords(records, scenario, viewport);
    if (scenario === "standby-design-alignment-compressed" && viewport === "1280x720" && cells.some((record) => record.geometry.forecast == null)) {
      throw new Error(`${scenario}/${viewport}: side forecast was not visible for every rotation tick`);
    }
    const forecast = cells.find((record) => record.rotationTick === tick && record.cardPageTick === 0)?.geometry.forecast;
    if (forecast == null || forecast.periodCount !== 4 || forecast.periodKeys.length !== 4 || forecast.footer == null || !/^\d+\/32$/.test(forecast.page)) throw new Error(`${scenario}/${viewport}: 128-period forecast max atom/footer was not captured`);
  }
}

function assertBaselineTyphoonCoverage(records) {
  const targets = [
    { scenario: "standby-vpta50-probability-muted", viewport: "1280x720", tick: null, mode: "full", prefectures: 5, tone: "muted" },
    { scenario: "standby-vpta50-probability-normal", viewport: "1280x720", tick: null, mode: "full", prefectures: 5, tone: "normal" },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].typhoonCaptureTick, mode: "compact", prefectures: 3, tone: null },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].typhoonCaptureTick, mode: "compact", prefectures: 3, tone: null },
  ];
  for (const target of targets) {
    const typhoon = findRecords(records, target.scenario, target.viewport).find((record) => record.rotationTick === target.tick && record.cardPageTick === 0)?.geometry.typhoon;
    if (typhoon == null || typhoon.displayMode !== target.mode) throw new Error(`${target.scenario}/${target.viewport}: ${target.mode} Typhoon was not captured`);
    const counts = Object.fromEntries(["maximum", "prefecture", "worst"].map((role) => [role, typhoon.roles.filter((entry) => entry.role === role).length]));
    assertDeepEqual(counts, { maximum: 1, prefecture: target.prefectures, worst: 1 }, `${target.scenario}/${target.viewport} baseline probability roles`);
    if (typhoon.roles.some((role) => role.legacyNode == null || role.unit !== "%")) throw new Error(`${target.scenario}/${target.viewport}: legacy probability node/value missing`);
    if (target.tone === "muted") {
      if (!typhoon.header.className.split(/\s+/).includes("standby-card-header--muted") || typhoon.header.customProperties.container !== "" || typhoon.header.customProperties.on !== "" || typhoon.header.customProperties.band !== "") throw new Error(`${target.scenario}: muted header fixture mismatch`);
    } else if (target.tone === "normal") {
      if ([typhoon.header.customProperties.container, typhoon.header.customProperties.on, typhoon.header.customProperties.band].some((value) => value === "") || typhoon.header.bandWidth !== 4) throw new Error(`${target.scenario}: VPTW header fixture mismatch`);
    }
  }
}

export function assertDesignAlignmentBriefingGrid(grid, expectation, label = "briefing grid") {
  if (grid == null) throw new Error(`${label}: missing`);
  assertNoOverflow(grid.body, `${label} body`);
  assertNoOverflow(grid.grid, `${label} grid`);
  assertDesignAlignmentApprox(grid.bodyPadding.left, expectation.padding, 0.1, `${label} body padding-left`);
  assertDesignAlignmentApprox(grid.bodyPadding.right, expectation.padding, 0.1, `${label} body padding-right`);
  assertDesignAlignmentApprox(grid.rowGap, expectation.rowGap, 0.1, `${label} row gap`);
  assertDesignAlignmentApprox(grid.columnGap, expectation.columnGap, 0.1, `${label} column gap`);
  assertDesignAlignmentApprox(grid.margin.left, 0, 0.1, `${label} margin-left`);
  assertDesignAlignmentApprox(grid.margin.right, 0, 0.1, `${label} margin-right`);
  const columns = grid.gridTemplateColumns.trim().split(/\s+/).map(Number.parseFloat);
  if (columns.length !== 2 || columns.some((column) => !Number.isFinite(column))) throw new Error(`${label}: grid did not resolve to exactly two columns`);
  for (const [index, column] of columns.entries()) assertDesignAlignmentApprox(column, expectation.statWidth, 1, `${label} grid column ${index + 1}`);
  assertDesignAlignmentApprox(grid.grid.rect.left, grid.body.rect.left + grid.bodyPadding.left, 1, `${label} left gutter`);
  assertDesignAlignmentApprox(grid.grid.rect.right, grid.body.rect.right - grid.bodyPadding.right, 1, `${label} right gutter`);
  assertDeepEqual(grid.stats.map((stat) => stat.role), ["location", "amount", "time", "duration"], `${label} stat DOM order`);
  const [location, amount, time, duration] = grid.stats;
  for (const stat of grid.stats) {
    assertNoOverflow(stat.stat, `${label} ${stat.role}`);
    assertDesignAlignmentApprox(stat.stat.rect.width, expectation.statWidth, 1, `${label} ${stat.role} width`);
    assertDesignAlignmentApprox(stat.gap, expectation.statGap, 0.1, `${label} ${stat.role} gap`);
    assertNoOverflow(stat.value, `${label} ${stat.role} value`);
  }
  assertDesignAlignmentApprox(location.stat.rect.top, amount.stat.rect.top, 1, `${label} first row`);
  assertDesignAlignmentApprox(time.stat.rect.top, duration.stat.rect.top, 1, `${label} second row`);
  if (time.stat.rect.top <= location.stat.rect.top + 1) throw new Error(`${label}: rows did not resolve as 2x2`);
  assertDesignAlignmentApprox(location.stat.rect.left, time.stat.rect.left, 1, `${label} left column`);
  assertDesignAlignmentApprox(amount.stat.rect.left, duration.stat.rect.left, 1, `${label} right column`);
  if (location.value.lineCount !== 1 || !isDesignAlignmentSingleVisualLine(amount.value, [amount.numberUnit?.value, amount.numberUnit?.unit])) throw new Error(`${label}: location/amount wrapped`);
  if (amount.numberUnit == null) throw new Error(`${label}: amount NumberUnit missing`);
  for (const [name, node] of Object.entries(amount.numberUnit)) {
    assertNoOverflow(node, `${label} NumberUnit ${name}`);
    const fragments = name === "wrapper" ? [amount.numberUnit.value, amount.numberUnit.unit] : [];
    if (!isDesignAlignmentSingleVisualLine(node, fragments)) throw new Error(`${label} NumberUnit ${name}: wrapped`);
  }
}

function assertBriefingMatrix(records) {
  const matrix = [
    { scenario: "standby-briefing-design-alignment", viewport: "1280x720", cardWidth: 307.2, padding: 16, rowGap: 4, columnGap: 12, statWidth: 130.6, statGap: 4 },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", cardWidth: 321.28, padding: 8, rowGap: 2, columnGap: 6, statWidth: 148.64, statGap: 2 },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", cardWidth: 280, padding: 8, rowGap: 2, columnGap: 6, statWidth: 128, statGap: 2 },
  ];
  for (const condition of matrix) {
    const briefingTick = condition.scenario === "standby-design-alignment-compressed"
      ? DESIGN_ALIGNMENT_COMPRESSED_PLANS[condition.viewport].briefingCaptureTick : null;
    const relevant = findRecords(records, condition.scenario, condition.viewport)
      .filter((record) => condition.scenario !== "standby-design-alignment-compressed" || record.rotationTick === briefingTick);
    const briefingReports = relevant.map((record) => record.geometry.briefing).filter(Boolean);
    const grids = briefingReports.flatMap((briefing) => briefing.grids);
    const byLocation = new Map(grids.map((grid) => [grid.location, grid]));
    if (!byLocation.has("さいたま市") || !byLocation.has("美幌町")) throw new Error(`${condition.scenario}/${condition.viewport}: both real precipitation facts were not captured`);
    for (const [location, expectedAmount] of [["さいたま市", "約100mm"], ["美幌町", "120mm以上"]]) {
      const grid = byLocation.get(location);
      if (grid.amount !== expectedAmount) throw new Error(`${condition.scenario}/${condition.viewport}/${location}: expected ${expectedAmount}, got ${grid.amount}`);
      assertDesignAlignmentBriefingGrid(grid, condition, `${condition.scenario}/${condition.viewport}/${location}`);
      const amountStat = statByRole(grid, "amount");
      const expectedNumber = location === "さいたま市" ? "100" : "120";
      if (grid.approximation !== (location === "さいたま市" ? "approx" : "atLeast")
        || amountStat?.numberUnit?.value?.text !== expectedNumber || amountStat?.numberUnit?.unit?.text !== "mm") {
        throw new Error(`${condition.scenario}/${condition.viewport}/${location}: precipitation value/qualifier changed`);
      }
      const card = briefingReports.find((report) => report.grids.includes(grid))?.card;
      assertDesignAlignmentApprox(card?.rect?.width, condition.cardWidth, 1, `${condition.scenario}/${condition.viewport} card width`);
    }
    const measuredWidth = relevant[0]?.geometry.layout.measurementWidths.briefing;
    const liveWidth = briefingReports.find((report) => report.grids.length > 0)?.card?.rect?.width;
    assertDesignAlignmentApprox(liveWidth, measuredWidth, 1, `${condition.scenario}/${condition.viewport} briefing live/measurement width`);
  }
}

function assertForecastGeometry(forecast, compressed, label) {
  if (forecast == null) throw new Error(`${label}: forecast missing`);
  for (const [name, box] of [["card", forecast.card], ["header", forecast.header], ["atom", forecast.atom], ["footer", forecast.footer], ["periods", forecast.periods]]) assertNoOverflow(box, `${label} ${name}`);
  const block = compressed ? 4 : 8;
  const inline = compressed ? 8 : 16;
  assertDesignAlignmentApprox(forecast.headerPadding.top, block, 0.1, `${label} header padding-top`);
  assertDesignAlignmentApprox(forecast.headerPadding.bottom, block, 0.1, `${label} header padding-bottom`);
  assertDesignAlignmentApprox(forecast.headerPadding.left, inline, 0.1, `${label} header padding-left`);
  assertDesignAlignmentApprox(forecast.headerPadding.right, inline, 0.1, `${label} header padding-right`);
  assertDesignAlignmentApprox(forecast.periodGap, compressed ? 2 : 4, 0.1, `${label} period gap`);
  if (forecast.periodCount !== 4 || forecast.periodKeys.length !== 4 || forecast.footer == null || !/^\d+\/32$/.test(forecast.page)) throw new Error(`${label}: max atom/footer contract failed`);
  if (forecast.atomFooterOverlap > 1) throw new Error(`${label}: atom/footer overlap ${forecast.atomFooterOverlap}`);
}

function assertForecast(records, baseline) {
  const targets = [
    { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, delta: 12, compressed: false },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick, delta: 6, compressed: true },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick, delta: 6, compressed: true },
  ];
  for (const target of targets) {
    const afterRecord = findRecords(records, target.scenario, target.viewport).find((record) => record.rotationTick === target.tick && record.cardPageTick === 0);
    const beforeRecord = baseline.records.find((record) => record.manifestKey === afterRecord?.manifestKey);
    if (afterRecord == null || beforeRecord == null) throw new Error(`${target.scenario}/${target.viewport}: forecast comparison record missing`);
    const after = afterRecord.geometry.forecast;
    const before = beforeRecord.geometry.forecast;
    assertForecastGeometry(after, target.compressed, `${target.scenario}/${target.viewport}`);
    if (before == null) throw new Error(`${target.scenario}/${target.viewport}: baseline forecast missing`);
    assertDeepEqual(after.periodKeys, before.periodKeys, `${target.scenario}/${target.viewport} period keys`);
    assertDeepEqual(after.pageKeys, before.pageKeys, `${target.scenario}/${target.viewport} page keys`);
    assertDeepEqual(after.pageIdentities, before.pageIdentities, `${target.scenario}/${target.viewport} page identities`);
    if (after.identity !== before.identity) throw new Error(`${target.scenario}/${target.viewport}: atom identity changed`);
    assertDesignAlignmentApprox(after.naturalHeight - before.naturalHeight, target.delta, 1, `${target.scenario}/${target.viewport} natural height delta`);
  }
}

export function assertDesignAlignmentTyphoonProbability(typhoon, { mode, valueFontSize, prefectureCount, header }, label = "typhoon") {
  if (typhoon == null || typhoon.displayMode !== mode) throw new Error(`${label}: expected ${mode} Typhoon`);
  assertNoOverflow(typhoon.card, `${label} card`);
  const counts = Object.fromEntries(["maximum", "prefecture", "worst"].map((role) => [role, typhoon.roles.filter((entry) => entry.role === role).length]));
  assertDeepEqual(counts, { maximum: 1, prefecture: prefectureCount, worst: 1 }, `${label} probability roles`);
  for (const role of typhoon.roles) {
    for (const [name, node] of [["probabilityNumber", role.probabilityNumber], ["nuValue", role.nuValue], ["nuUnit", role.nuUnit]]) {
      assertNoOverflow(node, `${label} ${role.role}/${role.label} ${name}`);
      const fragments = name === "probabilityNumber" ? [role.nuValue, role.nuUnit] : [];
      if (!isDesignAlignmentSingleVisualLine(node, fragments)) throw new Error(`${label} ${role.role}/${role.label} ${name}: wrapped`);
    }
    if (role.unit !== "%") throw new Error(`${label} ${role.role}/${role.label}: unit is not %`);
    assertDesignAlignmentApprox(role.nuValue.fontSize, valueFontSize, 0.1, `${label} ${role.role}/${role.label} value font-size`);
    assertDesignAlignmentApprox(role.nuUnit.fontSize, 12, 0.1, `${label} ${role.role}/${role.label} unit font-size`);
    if (role.nuValue.fontWeight !== typhoon.resolvedNumWeight) throw new Error(`${label} ${role.role}/${role.label}: --num-weight mismatch`);
    if (!role.nuValue.fontVariantNumeric.split(/\s+/).includes("tabular-nums") || role.nuUnit.fontVariantNumeric !== "normal") throw new Error(`${label} ${role.role}/${role.label}: NumberUnit font-variant hierarchy mismatch`);
  }
  const tone = typhoon.header;
  if (tone == null) throw new Error(`${label}: header missing`);
  if (header === "muted") {
    if (tone.customProperties.container !== "" || tone.customProperties.on !== "" || tone.customProperties.band !== "") throw new Error(`${label}: muted header has semantic custom properties`);
    if (!tone.className.split(/\s+/).includes("standby-card-header--muted") || tone.background !== "rgba(0, 0, 0, 0)" || tone.color !== tone.roleMuted || tone.bandWidth !== 0) throw new Error(`${label}: muted header rendering mismatch`);
  } else if (header === "normal") {
    if ([tone.customProperties.container, tone.customProperties.on, tone.customProperties.band].some((value) => value === "") || tone.background === "rgba(0, 0, 0, 0)") throw new Error(`${label}: VPTW header variables/background missing`);
    assertDesignAlignmentApprox(tone.bandWidth, 4, 0.1, `${label} header band`);
  }
}

function roleValues(typhoon) {
  return typhoon.roles.map(({ role, label, value, unit }) => ({ role, label, value, unit }));
}

function assertTyphoon(records) {
  const muted = findRecords(records, "standby-vpta50-probability-muted", "1280x720")[0]?.geometry.typhoon;
  const normal = findRecords(records, "standby-vpta50-probability-normal", "1280x720")[0]?.geometry.typhoon;
  assertDesignAlignmentTyphoonProbability(muted, { mode: "full", valueFontSize: 19, prefectureCount: 5, header: "muted" }, "VPTA muted");
  assertDesignAlignmentTyphoonProbability(normal, { mode: "full", valueFontSize: 19, prefectureCount: 5, header: "normal" }, "VPTA normal");
  assertDeepEqual(roleValues(muted), roleValues(normal), "VPTA probability/header independence");
  assertDeepEqual(muted.roles.map(({ role, value }) => ({ role, value })), [
    { role: "maximum", value: 80 },
    { role: "prefecture", value: 80 }, { role: "prefecture", value: 70 }, { role: "prefecture", value: 60 },
    { role: "prefecture", value: 50 }, { role: "prefecture", value: 40 },
    { role: "worst", value: 80 },
  ], "VPTA full visible values");
  for (const viewport of ["1280x720", "960x620"]) {
    const tick = DESIGN_ALIGNMENT_COMPRESSED_PLANS[viewport].typhoonCaptureTick;
    const compact = findRecords(records, "standby-design-alignment-compressed", viewport).find((record) => record.rotationTick === tick && record.cardPageTick === 0)?.geometry.typhoon;
    assertDesignAlignmentTyphoonProbability(compact, { mode: "compact", valueFontSize: 14, prefectureCount: 3, header: null }, `VPTA compact ${viewport}`);
    assertDeepEqual(compact.roles.map(({ role, value }) => ({ role, value })), [
      { role: "maximum", value: 80 },
      { role: "prefecture", value: 80 }, { role: "prefecture", value: 70 }, { role: "prefecture", value: 60 },
      { role: "worst", value: 80 },
    ], `VPTA compact ${viewport} visible values`);
  }
}

export function assertDesignAlignmentBaselineIdentity(records, baselineRecords) {
  if (!Array.isArray(baselineRecords)) throw new Error("design-alignment baseline records missing");
  const beforeByKey = new Map(baselineRecords.map((record) => [record.manifestKey, record]));
  for (const after of records) {
    const before = beforeByKey.get(after.manifestKey);
    if (before == null) throw new Error(`${after.manifestKey}: baseline record missing`);
    for (const key of ["scenario", "rotationTick", "cardPageTick", "query", "urlIdentity"]) {
      if (before[key] !== after[key]) throw new Error(`${after.manifestKey}: baseline ${key} mismatch`);
    }
    assertDeepEqual(before.viewport, after.viewport, `${after.manifestKey} baseline viewport`);
  }
  if (beforeByKey.size !== records.length) throw new Error("design-alignment baseline has extra records");
}

function numericComparison(before, after) {
  const base = Number.isFinite(before) ? before : null;
  const current = Number.isFinite(after) ? after : null;
  return { base, after: current, delta: base == null || current == null ? null : current - base };
}

function placementSnapshot(layout) {
  return {
    left: Array.isArray(layout?.placementLeft) ? layout.placementLeft : [],
    right: Array.isArray(layout?.placementRight) ? layout.placementRight : [],
    center: Array.isArray(layout?.placementCenter) ? layout.placementCenter : [],
  };
}

function rotationSnapshot(layout) {
  return {
    keys: Array.isArray(layout?.rotationKeys) ? layout.rotationKeys : [],
    omittedCount: Number.isFinite(layout?.rotationOmittedCount) ? layout.rotationOmittedCount : null,
    activeKey: layout?.rotationActiveKey ?? null,
    position: layout?.rotationPosition ?? null,
  };
}

function visibleCardSnapshot(layout) {
  if (!Array.isArray(layout?.visibleCards)) return [];
  return layout.visibleCards.map(({ key, surface }) => ({ key, surface }));
}

function visibleCardHeights(layout) {
  if (!Array.isArray(layout?.visibleCards)) return {};
  return Object.fromEntries(layout.visibleCards.map((card) => [
    card.key,
    Number.isFinite(card.component?.rect?.height) ? card.component.rect.height
      : Number.isFinite(card.host?.rect?.height) ? card.host.rect.height : null,
  ]));
}

function scalarComparison(before, after) {
  const base = before ?? null;
  const current = after ?? null;
  return { base, after: current, changed: base !== current };
}

function heightComparison(beforeLayout, afterLayout) {
  const base = visibleCardHeights(beforeLayout);
  const after = visibleCardHeights(afterLayout);
  const delta = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(after)])) delta[key] = numericComparison(base[key], after[key]).delta;
  return { base, after, delta };
}

export function buildDesignAlignmentComparison(records, baselineRecords) {
  assertDesignAlignmentBaselineIdentity(records, baselineRecords);
  const beforeByKey = new Map(baselineRecords.map((record) => [record.manifestKey, record]));
  return records.map((afterRecord) => {
    const beforeRecord = beforeByKey.get(afterRecord.manifestKey);
    const before = beforeRecord.geometry;
    const after = afterRecord.geometry;
    const basePlacement = placementSnapshot(before.layout);
    const afterPlacement = placementSnapshot(after.layout);
    const baseRotation = rotationSnapshot(before.layout);
    const afterRotation = rotationSnapshot(after.layout);
    const baseVisibleCards = visibleCardSnapshot(before.layout);
    const afterVisibleCards = visibleCardSnapshot(after.layout);
    return {
      manifestKey: afterRecord.manifestKey,
      scenario: afterRecord.scenario,
      viewport: afterRecord.viewport,
      rotationTick: afterRecord.rotationTick,
      cardPageTick: afterRecord.cardPageTick,
      stages: {
        ladder: numericComparison(before.layout?.ladderStage, after.layout?.ladderStage),
        measurementGeometry: numericComparison(before.layout?.measurementGeometryStage, after.layout?.measurementGeometryStage),
      },
      compressed: scalarComparison(before.layout?.compressed, after.layout?.compressed),
      rotationOmittedCount: numericComparison(before.layout?.rotationOmittedCount, after.layout?.rotationOmittedCount),
      placement: { base: basePlacement, after: afterPlacement, changed: stableJson(basePlacement) !== stableJson(afterPlacement) },
      rotation: { base: baseRotation, after: afterRotation, changed: stableJson(baseRotation) !== stableJson(afterRotation) },
      typhoonVariant: {
        base: before.layout?.typhoonVariant ?? null,
        after: after.layout?.typhoonVariant ?? null,
        changed: before.layout?.typhoonVariant !== after.layout?.typhoonVariant,
      },
      visibleCards: { base: baseVisibleCards, after: afterVisibleCards, changed: stableJson(baseVisibleCards) !== stableJson(afterVisibleCards) },
      cardHeights: heightComparison(before.layout, after.layout),
      forecastNaturalHeight: numericComparison(before.forecast?.naturalHeight, after.forecast?.naturalHeight),
    };
  });
}

export function assertDesignAlignmentComparisonPolicy(comparisons) {
  for (const comparison of comparisons.filter((entry) => entry.scenario === "standby-design-alignment-compressed" || entry.scenario === "legacy-standby-gate")) {
    for (const [name, stage] of Object.entries(comparison.stages)) {
      if (stage.base == null || stage.after == null || stage.delta !== 0) throw new Error(`${comparison.manifestKey}: base/after ${name} stage must remain unchanged`);
    }
    for (const [name, snapshot] of [["placement", comparison.placement], ["rotation", comparison.rotation], ["Typhoon variant", comparison.typhoonVariant], ["visible cards", comparison.visibleCards]]) {
      if (snapshot.changed) throw new Error(`${comparison.manifestKey}: base/after ${name} changed`);
    }
    if (comparison.compressed.base !== true || comparison.compressed.after !== true || comparison.compressed.changed) throw new Error(`${comparison.manifestKey}: base/after compressed state changed`);
    if (comparison.rotationOmittedCount.base == null || comparison.rotationOmittedCount.after == null || comparison.rotationOmittedCount.delta !== 0) throw new Error(`${comparison.manifestKey}: base/after omitted rotation count changed`);
  }
  for (const target of [
    { scenario: "standby-vpwp50-forecast", viewport: "1280x720", tick: null, delta: 12 },
    { scenario: "standby-design-alignment-compressed", viewport: "1280x720", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["1280x720"].forecastCaptureTick, delta: 6 },
    { scenario: "standby-design-alignment-compressed", viewport: "960x620", tick: DESIGN_ALIGNMENT_COMPRESSED_PLANS["960x620"].forecastCaptureTick, delta: 6 },
  ]) {
    const comparison = comparisons.find((entry) => entry.scenario === target.scenario
      && entry.viewport.label === target.viewport && entry.rotationTick === target.tick && entry.cardPageTick === 0);
    if (comparison == null) throw new Error(`${target.scenario}/${target.viewport}: forecast comparison record missing`);
    assertDesignAlignmentApprox(comparison.forecastNaturalHeight.delta, target.delta, 1, `${target.scenario}/${target.viewport} natural height delta`);
  }
}

export function resolveDesignAlignmentCaptureMode({ writeBaseline, baselineReport }) {
  if (writeBaseline != null && baselineReport != null) throw new Error("choose either --write-baseline or --baseline-report");
  if (writeBaseline != null) return "baseline";
  if (baselineReport != null) return "after";
  throw new Error("design-alignment suite requires --write-baseline or --baseline-report");
}

export function resolveDesignAlignmentExecutionMode({ suite, assertFrom, writeBaseline, baselineReport }) {
  if (assertFrom == null) return "capture";
  if (suite !== "design-alignment") throw new Error("--assert-from requires --suite design-alignment");
  if (writeBaseline != null) throw new Error("--assert-from cannot be combined with --write-baseline");
  if (baselineReport == null) throw new Error("--assert-from requires --baseline-report");
  return "assert-from";
}

export function createDesignAlignmentRecordsArtifact({ mode, records, baseline }) {
  return { suite: "design-alignment", mode, records, baseline };
}

export function isDesignAlignmentScreenshotArtifact(name) {
  return name.startsWith("design-alignment-") && name.endsWith(".png");
}

async function cleanDesignAlignmentScreenshots(outDir) {
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && isDesignAlignmentScreenshotArtifact(entry.name))
    .map((entry) => rm(join(outDir, entry.name), { force: true })));
}

export function assertDesignAlignmentManifest(records, { mode, baseline = null }) {
  if (mode === "baseline") {
    assertDesignAlignmentBaselineStructure(records);
    return null;
  }
  if (mode !== "after") throw new Error(`unknown design-alignment assertion mode: ${mode}`);
  if (baseline == null || baseline.suite !== "design-alignment") throw new Error("design-alignment baseline suite mismatch");
  if (baseline.mode != null && baseline.mode !== "baseline") throw new Error("design-alignment baseline mode mismatch");
  assertDesignAlignmentBaselineStructure(baseline.records ?? []);
  assertDesignAlignmentManifestCoverage(records);
  for (const record of records) assertRequiredReport(record);
  assertCompressedPlan(records, "1280x720");
  assertCompressedPlan(records, "960x620");
  assertDesignAlignmentMaxFixture(records);
  assertBriefingCaptureCoverage(records);
  assertBaselineForecastCoverage(records);
  assertBaselineTyphoonCoverage(records);
  const comparison = buildDesignAlignmentComparison(records, baseline.records);
  assertDesignAlignmentComparisonPolicy(comparison);
  assertBriefingMatrix(records);
  assertForecast(records, baseline);
  assertTyphoon(records);
  return comparison;
}

export function assertDesignAlignmentSavedRecords(saved, baseline) {
  if (saved == null || saved.suite !== "design-alignment" || !Array.isArray(saved.records)) throw new Error("invalid design-alignment records file");
  if (saved.mode != null && saved.mode !== "after") throw new Error("design-alignment records file is not an after capture");
  const baseAfterComparison = assertDesignAlignmentManifest(saved.records, { mode: "after", baseline });
  return { suite: "design-alignment", mode: "after", records: saved.records, baseAfterComparison };
}

async function runDesignAlignmentAssertionsFromFile(options) {
  const assertFrom = resolve(options.assertFrom);
  const baselineReport = resolve(options.baselineReport);
  const [saved, baseline] = await Promise.all([
    readFile(assertFrom, "utf8").then(JSON.parse),
    readFile(baselineReport, "utf8").then(JSON.parse),
  ]);
  const report = { ...assertDesignAlignmentSavedRecords(saved, baseline), assertFrom, baselineReport };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runDesignAlignmentSuite({ options, chrome, profileDir, baseUrl, outDir }) {
  const mode = resolveDesignAlignmentCaptureMode(options);
  await cleanDesignAlignmentScreenshots(outDir);
  const records = [];
  for (const entry of DESIGN_ALIGNMENT_MANIFEST) {
    const url = designAlignmentUrl(baseUrl, entry);
    records.push(await captureDesignAlignmentPage({
      chrome, profileDir, url, viewport: parseViewport(entry.viewport), outDir, entry,
    }));
  }
  const baseline = options.baselineReport == null ? null : JSON.parse(await readFile(options.baselineReport, "utf8"));
  const recordsArtifactPath = join(outDir, "design-alignment-records.json");
  await writeFile(recordsArtifactPath, `${JSON.stringify(createDesignAlignmentRecordsArtifact({ mode, records, baseline }), null, 2)}\n`);
  const baseAfterComparison = assertDesignAlignmentManifest(records, { mode, baseline });
  const report = { suite: "design-alignment", mode, recordsArtifactPath, records, ...(baseAfterComparison == null ? {} : { baseAfterComparison }) };
  if (options.writeBaseline != null) await writeFile(options.writeBaseline, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let options;
  try { options = parseCaptureArgs(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  if (options == null) { usage(); return; }
  if (options.suite != null && options.suite !== "design-alignment") throw new Error("unknown suite");
  if (resolveDesignAlignmentExecutionMode(options) === "assert-from") {
    await runDesignAlignmentAssertionsFromFile(options);
    return;
  }
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
    if (options.suite === "design-alignment") {
      await runDesignAlignmentSuite({ options, chrome, profileDir, baseUrl, outDir });
      return;
    }
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

const directlyInvoked = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directlyInvoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
