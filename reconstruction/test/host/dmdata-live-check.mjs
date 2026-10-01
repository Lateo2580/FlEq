// P3-C2-AC09 (2): the live dmdata check through the product path. Only the author runs it, on their own terminal outside any agent:
//   DMDATA_API_KEY=... node reconstruction/test/host/dmdata-live-check.mjs <config.json>   and stop it with SIGINT.
// Needs reconstruction/dist (tsc --project reconstruction/tsconfig.json). The config JSON has appName, classifications,
// stateDirectory, diagnosticDirectory, displayPort and outputPath, and no key field: the key comes from DMDATA_API_KEY only.
// outputPath gets secret-free evidence only: (a) projected socket lists before start, after start and after stop,
// (b) control frame and T0 times, (c) /snapshot connection and sequence every 10 s, (d) how the stop ended and how long it took.
import { readFileSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { performance } from "node:perf_hooks";

const apiKey = process.env.DMDATA_API_KEY;
if (apiKey == null || apiKey === "") {
  process.stderr.write("DMDATA_API_KEY is not set: nothing was sent\n");
  process.exit(1);
}
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { startP2Host } = await import("../../dist/src/host/host.js");
const { listSockets } = await import("../../dist/src/host/dmdata-rest.js");

const evidence = { appName: config.appName, classifications: config.classifications, lists: [], controlFrames: [], t0: [],
  snapshots: [], start: null, stop: null };
const write = () => writeFileSync(config.outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
// (a) The product's projected lists carry id, appName, status and classifications only.
const lists = async (at) => {
  const [open, waiting] = await Promise.all([listSockets(apiKey, "open"), listSockets(apiKey, "waiting")]);
  evidence.lists.push({ at, wallTimeMs: Date.now(), open, waiting });
};
// (c) Only the connection view and the sequence; no telegram content.
const sample = (port) => new Promise((done) => {
  const at = { monotonicMs: performance.now(), wallTimeMs: Date.now() };
  get({ host: "127.0.0.1", port, path: "/snapshot", agent: false }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => {
      try {
        const { connection: { state, disconnectedAt, lastInputAt }, sequence } = JSON.parse(body);
        evidence.snapshots.push({ ...at, connection: { state, disconnectedAt, lastInputAt }, sequence });
      } catch { evidence.snapshots.push({ ...at, error: "unreadable" }); }
      done();
    });
  }).on("error", () => { evidence.snapshots.push({ ...at, error: "unreachable" }); done(); });
});

await lists("beforeStart");
const clock = () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
let host;
try {
  host = await startP2Host({ dmdata: { apiKey, appName: config.appName, classifications: config.classifications },
    stateDirectory: config.stateDirectory, diagnosticDirectory: config.diagnosticDirectory, displayPort: config.displayPort, clock,
    // (b) frameType, time and the error close flag; no pingId, no body.
    observe: (o) => {
      if (o.kind === "controlFrame") evidence.controlFrames.push({ frameType: o.frameType, monotonicMs: o.monotonicMs, errorClose: o.errorClose });
      else if (o.kind === "marker" && o.point === "T0") evidence.t0.push(o.monotonicMs);
    } });
} catch (error) {
  // The host's rejections are fixed texts (AC08).
  evidence.start = { rejected: error instanceof Error ? error.message : "rejected" };
  write();
  process.exit(1);
}
evidence.start = { displayPort: host.displayPort, monotonicMs: performance.now() };
await lists("afterStart");
await sample(host.displayPort);
const sampler = setInterval(() => { void sample(host.displayPort); }, 10_000);

// (d) startP2Host's own SIGINT handler starts the stop; this one waits for the same stop and writes the evidence.
process.once("SIGINT", async () => {
  clearInterval(sampler);
  const begun = performance.now();
  try {
    const summary = await host.stop();
    evidence.stop = { durationMs: performance.now() - begun, code: summary.code, reasons: summary.reasons };
  } catch { evidence.stop = { durationMs: performance.now() - begun, error: "stop failed" }; }
  await lists("afterStop");
  write();
  process.stdout.write(`evidence written to ${config.outputPath}\n`);
  process.exit(0);
});
