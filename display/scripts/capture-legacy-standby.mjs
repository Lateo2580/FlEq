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
const MIME_TYPES = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"],
  [".map", "application/json"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"],
]);

function usage(message) {
  if (message != null) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/capture-legacy-standby.mjs [--report] [--fixture overflow|overlap|rotation|cluster|cluster-calm] [--url URL] [--scenario quiet|4|7|max|max-floodWide] [--viewport WIDTHxHEIGHT] [--out-dir PATH]\n");
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

function gateUrl(baseUrl, scenario, rotationTick = null, fixture = null) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  url.searchParams.set("gateScenario", scenario);
  if (rotationTick != null) url.searchParams.set("rotationTick", String(rotationTick));
  if (fixture != null) url.searchParams.set("gateFixture", fixture);
  url.hash = "legacy-standby-gate";
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
    "data-flood-readable-overflow-keys",
    "data-typhoon-variant",
  ];
  const diagnostics = Object.fromEntries(attributes.map((attribute) => {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}="([^"]*)"`).exec(dom);
    return [attribute, match == null ? null : decodeHtmlAttribute(match[1])];
  }));
  if (diagnostics["data-measurement-settled"] !== "true") throw new Error(`measurement did not settle: ${JSON.stringify(diagnostics)}`);
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

function assertNarrowGeometry(diagnostics, scenario, viewport) {
  if (viewport.label !== "960x620") return;
  if (scenario === "quiet") expectEqual(diagnostics["data-ladder-stage"], "0", "960px quiet stage");
  // Spec §5 / ruling ⑤ follow-up: scenario 7 makes weather permanent after
  // the surface fix, while max still requires weather in the rotation slot.
  if (scenario === "max" || scenario === "7") {
    expectEqual(diagnostics["data-ladder-stage"], "3", `960px scenario-${scenario} stage (§5)`);
    expectEqual(diagnostics["data-rotation-keys"], scenario === "7" ? "flood,typhoon,volcano,heat" : "weather,flood,typhoon,volcano,heat", `960px scenario-${scenario} rotation set (§5)`);
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

function assertFloodReadability(diagnostics) {
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

const FLOOD_WIDE_EXPECTATIONS = {
  "1920x1080": { stage: "1", rotationKeys: "", typhoonVariant: "compact", floodForm: "wide", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 24, n: 0 } } }, surplus: "21" },
  "1280x720": { stage: "3", rotationKeys: "flood,typhoon,volcano,heat", typhoonVariant: "compact", floodForm: "card", expandedCounts: { quake: { count: 4, n: 3 }, weather: { "大雨警報(土砂災害)": { count: 10, n: 14 } } }, surplus: "7" },
};

// §5 / §11.1 fixed tables. --report emits this comparison without mutating
// either source of truth, so a newly measured table needs an explicit ruling.
const TABLE_EXPECTATIONS = {
  quiet: { "1920x1080": { stage: "0", rotationKeys: "" }, "1512x982": { stage: "0", rotationKeys: "" }, "1280x720": { stage: "0", rotationKeys: "" }, "960x620": { stage: "0", rotationKeys: "" } },
  "4": { "1920x1080": { stage: "0", rotationKeys: "" }, "1512x982": { stage: "0", rotationKeys: "" }, "1280x720": { stage: "1", rotationKeys: "" }, "960x620": { stage: "2", rotationKeys: "" } },
  "7": { "1920x1080": { stage: "0", rotationKeys: "" }, "1512x982": { stage: "0", rotationKeys: "" }, "1280x720": { stage: "3", rotationKeys: "flood,typhoon,volcano,heat" }, "960x620": { stage: "3", rotationKeys: "flood,typhoon,volcano,heat" } },
  max: { "1920x1080": { stage: "1", rotationKeys: "" }, "1512x982": { stage: "1", rotationKeys: "" }, "1280x720": { stage: "3", rotationKeys: "flood,typhoon,volcano,heat" }, "960x620": { stage: "3", rotationKeys: "weather,flood,typhoon,volcano,heat" } },
};
// §11.1 C, keyed independently of the §5 ladder table. Keeping the measured
// payload here makes --report reject a stage match with stale expansion data.
const UTIL_EXPECTATIONS = {
  // In §11.1's human table "−（不在）" is encoded as the always-emitted
  // diagnostic value "none"; absence is never represented by a missing attr.
  "4": { "1920x1080": ["none", "none", 7, 0, 12, 0, 13], "1512x982": ["none", "none", 7, 0, 12, 0, 13], "1280x720": ["none", "none", 7, 0, 12, 0, 13], "960x620": ["none", "none", 7, 0, 9, 3, 10] },
  "7": { "1920x1080": ["compact", "card", 4, 3, 12, 0, 10], "1512x982": ["compact", "card", 4, 3, 2, 10, 0], "1280x720": ["compact", "card", 4, 3, 12, 0, 10], "960x620": ["compact", "card", 4, 3, 2, 10, 0] },
  max: { "1920x1080": ["full", "card", 7, 0, 24, 0, 25], "1512x982": ["compact", "card", 4, 3, 24, 0, 21], "1280x720": ["compact", "card", 4, 3, 10, 14, 7], "960x620": ["compact", "card", 4, 3, 3, 21, 0] },
};

function tableMismatches(diagnostics, scenario, viewport) {
  const expected = scenario === "max-floodWide"
    ? FLOOD_WIDE_EXPECTATIONS[viewport.label]
    : (() => {
      const base = TABLE_EXPECTATIONS[scenario]?.[viewport.label];
      const util = UTIL_EXPECTATIONS[scenario]?.[viewport.label];
      return base == null || util == null ? base : { ...base, typhoonVariant: util[0], floodForm: util[1], expandedCounts: { quake: { count: util[2], n: util[3] }, weather: { "大雨警報(土砂災害)": { count: util[4], n: util[5] } } }, surplus: String(util[6]) };
    })();
  if (expected == null) return [];
  const observed = {
    stage: diagnostics["data-ladder-stage"], rotationKeys: diagnostics["data-rotation-keys"],
    unresolved: diagnostics["data-layout-unresolved"], nonconverged: diagnostics["data-measurement-nonconverged"],
    centerClusterHidden: diagnostics["data-center-cluster-hidden"], floodForm: diagnostics["data-flood-form"],
    typhoonVariant: diagnostics["data-typhoon-variant"], expandedCounts: diagnostics["data-expanded-counts"],
    surplus: diagnostics["data-placement-surplus-use"],
  };
  const expectedValues = { stage: expected.stage, rotationKeys: expected.rotationKeys, unresolved: "false", nonconverged: "false", centerClusterHidden: "" };
  for (const key of ["floodForm", "typhoonVariant", "expandedCounts", "surplus"]) {
    if (expected[key] != null) expectedValues[key] = key === "expandedCounts" ? JSON.stringify(expected[key]) : expected[key];
  }
  return [
    ...Object.entries(expectedValues).flatMap(([key, value]) => observed[key] === value ? [] : [{ key, expected: value, actual: observed[key] }]),
    ...stageZeroClockMismatches(diagnostics),
  ];
}

function assertTableDiagnostics(diagnostics, scenario, viewport) {
  const mismatches = tableMismatches(diagnostics, scenario, viewport);
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

async function capture({ chrome, profileDir, url, scenario, viewport, outDir, rotationTick = null, assertTable = true }) {
  const tickSuffix = rotationTick == null ? "" : `-tick-${rotationTick}`;
  const stem = `legacy-standby-${scenario}-${viewport.label}${tickSuffix}`;
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
  const clusterFixture = url.includes("gateFixture=cluster");
  const clusterCalmFixture = url.includes("gateFixture=cluster-calm");
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
  assertGeometry(diagnostics, { skipWeatherHeight: clusterFixture });
  if (clusterFixture) assertClusterFixture(diagnostics, { requirePreRotation: clusterCalmFixture });
  assertClockHandoff(dom, diagnostics);
  if (!clusterFixture) assertRotationDiagnostics(diagnostics, rotationTick);
  if (assertTable && !url.includes("gateFixture=cluster")) {
    assertTableDiagnostics(diagnostics, scenario, viewport);
    assertFloodWideDiagnostics(diagnostics, scenario, viewport);
  }
  const report = { scenario, rotationTick, viewport: { width: viewport.width, height: viewport.height }, url, pngPath, diagnostics, mismatches: tableMismatches(diagnostics, scenario, viewport) };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(domPath, { force: true });
  return { scenario, viewport, rotationTick, pngPath, jsonPath, diagnostics, mismatches: tableMismatches(diagnostics, scenario, viewport) };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  if (options == null) { usage(); return; }
  const scenarios = options.scenarios.length === 0 ? DEFAULT_SCENARIOS : options.scenarios;
  if (scenarios.some((scenario) => !SUPPORTED_SCENARIOS.includes(scenario))) throw new Error("scenario must be quiet, 4, 7, max, or max-floodWide");
  if (options.fixture != null && !["overflow", "overlap", "rotation", "cluster", "cluster-calm"].includes(options.fixture)) throw new Error("fixture must be overflow, overlap, rotation, cluster, or cluster-calm");
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
        ? scenario === "max-floodWide" ? FLOOD_WIDE_VIEWPORTS : options.report ? DEFAULT_VIEWPORTS : scenario === "quiet" ? ["960x620"] : DEFAULT_VIEWPORTS
        : requestedViewports.map((viewport) => viewport.label);
      const viewports = viewportLabels.map(parseViewport);
      for (const viewport of viewports) {
        const first = await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, 0, options.fixture), scenario, viewport, outDir, rotationTick: 0, assertTable: !options.report });
        results.push(first);
        const rotationKeys = (first.diagnostics["data-rotation-keys"] ?? "").split(",").filter(Boolean);
        if (first.diagnostics["data-ladder-stage"] === "3") {
          for (let rotationTick = 1; rotationTick < rotationKeys.length; rotationTick += 1) {
            results.push(await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario, rotationTick, options.fixture), scenario, viewport, outDir, rotationTick, assertTable: !options.report }));
          }
        }
      }
    }
    const cells = results.filter((result) => result.rotationTick === 0).map((result) => ({
      scenario: result.scenario, viewport: result.viewport, match: result.mismatches.length === 0,
      mismatches: result.mismatches, diagnostics: result.diagnostics,
    }));
    process.stdout.write(`${JSON.stringify(options.report ? { outDir, cells } : { outDir, results }, null, 2)}\n`);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
    if (staticServer != null) await staticServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
