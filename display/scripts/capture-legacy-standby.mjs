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
const DEFAULT_SCENARIOS = ["4", "7", "max"];
const DEFAULT_VIEWPORTS = ["1920x1080", "1512x982", "1280x720", "960x620"];
const MIME_TYPES = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"],
  [".map", "application/json"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"],
]);

function usage(message) {
  if (message != null) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/capture-legacy-standby.mjs [--url URL] [--scenario 4|7|max] [--viewport WIDTHxHEIGHT] [--out-dir PATH]\n");
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { url: null, scenarios: [], viewports: [], outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--url" || argument === "--scenario" || argument === "--viewport" || argument === "--out-dir") {
      if (value == null) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--url") result.url = value;
      if (argument === "--scenario") result.scenarios.push(value);
      if (argument === "--viewport") result.viewports.push(value);
      if (argument === "--out-dir") result.outDir = value;
      continue;
    }
    if (argument === "--help" || argument === "-h") return null;
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (match == null) throw new Error(`invalid viewport: ${value}`);
  return { label: value, width: Number(match[1]), height: Number(match[2]) };
}

function run(command, args, stdoutFd = null) {
  return new Promise((resolveRun, rejectRun) => {
    // macOS Chrome can abort when its headless output is connected to a pipe.
    // Dump DOM to a regular file instead, keeping the browser process isolated.
    const child = spawn(command, args, { stdio: ["ignore", stdoutFd ?? "ignore", "ignore"] });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) resolveRun();
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

function gateUrl(baseUrl, scenario) {
  const url = new URL(baseUrl);
  url.searchParams.set("nav", "0");
  url.searchParams.set("gateScenario", scenario);
  url.hash = "legacy-standby-gate";
  return url.toString();
}

function diagnosticsFromDom(dom) {
  const attributes = ["data-ladder-stage", "data-measurement-settled", "data-layout-unresolved", "data-measurement-nonconverged"];
  const diagnostics = Object.fromEntries(attributes.map((attribute) => {
    const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}="([^"]*)"`).exec(dom);
    return [attribute, match?.[1] ?? null];
  }));
  if (diagnostics["data-measurement-settled"] !== "true") throw new Error(`measurement did not settle: ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}

async function capture({ chrome, profileDir, url, scenario, viewport, outDir }) {
  const stem = `legacy-standby-${scenario}-${viewport.label}`;
  const pngPath = join(outDir, `${stem}.png`);
  const jsonPath = join(outDir, `${stem}.json`);
  const domPath = join(outDir, `${stem}.dom.html`);
  const chromeArgs = [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--user-data-dir=${profileDir}`,
    `--window-size=${viewport.width},${viewport.height}`, "--virtual-time-budget=10000", url,
  ];
  await run(chrome, [...chromeArgs.slice(0, -1), `--screenshot=${pngPath}`, url]);
  const domFile = await open(domPath, "w");
  try {
    await run(chrome, [...chromeArgs.slice(0, -1), "--dump-dom", url], domFile.fd);
  } finally {
    await domFile.close();
  }
  const diagnostics = diagnosticsFromDom(await readFile(domPath, "utf8"));
  const report = { scenario, viewport: { width: viewport.width, height: viewport.height }, url, pngPath, diagnostics };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await rm(domPath, { force: true });
  return { pngPath, jsonPath, diagnostics };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { usage(error.message); return; }
  if (options == null) { usage(); return; }
  const scenarios = options.scenarios.length === 0 ? DEFAULT_SCENARIOS : options.scenarios;
  if (scenarios.some((scenario) => !DEFAULT_SCENARIOS.includes(scenario))) throw new Error("scenario must be 4, 7, or max");
  const viewports = (options.viewports.length === 0 ? DEFAULT_VIEWPORTS : options.viewports).map(parseViewport);
  const outDir = resolve(options.outDir ?? join(DISPLAY_DIR, "artifacts", "legacy-standby"));
  await mkdir(outDir, { recursive: true });
  const chrome = process.env.CHROME_BIN ?? "chrome";
  const staticServer = options.url == null ? await startStaticServer() : null;
  const baseUrl = options.url ?? staticServer.url;
  const profileDir = await mkdtemp(join(outDir, ".chrome-profile-"));
  try {
    const results = [];
    for (const scenario of scenarios) {
      for (const viewport of viewports) results.push(await capture({ chrome, profileDir, url: gateUrl(baseUrl, scenario), scenario, viewport, outDir }));
    }
    process.stdout.write(`${JSON.stringify({ outDir, results }, null, 2)}\n`);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
    if (staticServer != null) await staticServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
