import { execFileSync } from "node:child_process";
import { existsSync, promises as fileSystem, readFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import { startP2Host } from "../../src/host/host";

const hook = vi.hoisted(() => ({ beforeDecode: null as (() => void) | null, probeGate: null as Promise<void> | null }));
// The product notification backends would pop a real notification and play a sound for every EEW; the asset base is real.
vi.mock("../../src/notification-delivery/adapter", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/notification-delivery/adapter")>(),
  probeDesktopBackend: () => ({ kind: "idle" }),
  probeSoundBackend: async () => { await hook.probeGate; return { kind: "delivered" }; },
  runNotificationAttempt: async (attempt: { attemptId: string; intentId: string; channel: string }, clock: () => unknown) =>
    ({ kind: "delivered", attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: clock() }),
  abortNotificationAttempt: async () => ({ stopped: true }),
}));
vi.mock("../../src/decode-material/decode-material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/decode-material/decode-material")>();
  return { ...actual, decodeMaterial: (item: Parameters<typeof actual.decodeMaterial>[0]) => {
    hook.beforeDecode?.();
    return actual.decodeMaterial(item);
  } };
});

const EEW_AT = 1_713_363_299_001; // 37_01_01 VXSE43 ReportDateTime + 1 ms (same anchor as display-wiring)
const base = performance.now();
const skew = { ms: 0 };
const clock = () => {
  const monotonicMs = performance.now() + skew.ms;
  return { wallTimeMs: EEW_AT + Math.trunc(monotonicMs - base), monotonicMs };
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  hook.beforeDecode = null;
  hook.probeGate = null;
  skew.ms = 0;
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(condition: () => boolean | Promise<boolean>, milliseconds = 8_000): Promise<void> {
  const end = performance.now() + milliseconds;
  while (!(await condition())) {
    if (performance.now() > end) throw new Error("condition not reached");
    await new Promise((done) => setImmediate(done));
  }
}

async function localServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  const sockets: WebSocket[] = [];
  const received: string[] = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => { received.push(data.toString()); });
    ws.on("error", () => {});
  });
  cleanups.push(() => new Promise<void>((done) => { for (const ws of wss.clients) ws.terminate(); wss.close(() => done()); }));
  return { sockets, received, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/?token=secret-value` };
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as AddressInfo; probe.close(() => done(port)); });
  });
}

async function directories() {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a10-host-"));
  cleanups.push(() => fileSystem.rm(path, { recursive: true, force: true }));
  return { stateDirectory: join(path, "state"), diagnosticDirectory: join(path, "diagnostics") };
}

async function start(url: string, dirs: Awaited<ReturnType<typeof directories>>, observations: P2HostObservation[] = []) {
  const host = await startP2Host({ wsUrl: url, ...dirs, displayPort: 0, clock, observe: (o) => { observations.push(o); } });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  return host;
}

function fetchJson<Body>(port: number, path: string): Promise<Body> {
  return new Promise((resolveBody, reject) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolveBody(JSON.parse(body)));
    }).on("error", reject);
  });
}

type Sse = { snapshots: DisplaySnapshot[]; heartbeats: string[]; closed: boolean };
function events(port: number): Promise<Sse> {
  return new Promise((resolveStream, reject) => {
    get({ host: "127.0.0.1", port, path: "/events", agent: false }, (response) => {
      const stream: Sse = { snapshots: [], heartbeats: [], closed: false };
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = frame.split("\n");
          const data = JSON.parse(lines[lines.length - 1].slice("data: ".length));
          if (frame.startsWith("event: snapshot")) stream.snapshots.push(data);
          else stream.heartbeats.push(data.worker.state);
        }
      });
      response.on("close", () => { stream.closed = true; });
      response.on("error", () => {});
      resolveStream(stream);
    }).on("error", reject);
  });
}

const snapshot = (port: number) => fetchJson<DisplaySnapshot>(port, "/snapshot");
const vxse43 = readFileSync("test/fixtures/37_01_01_240613_VXSE43.xml", "utf8");
function dataFrame(headType: string, body: string): string {
  return JSON.stringify({ type: "data", version: "2.0", classification: "eew.forecast", id: "id", format: "xml",
    encoding: "utf-8", compression: null, head: { type: headType, author: "JMA", time: "2024-06-13T00:00:00Z", test: false, xml: true },
    xmlReport: { control: { status: "通常" } }, body });
}
const junk = () => dataFrame("VPWW57", "x");
async function diagnostics(dir: string): Promise<string> {
  const names = await fileSystem.readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(names.map((name) => fileSystem.readFile(join(dir, name), "utf8")))).join("");
}

describe("P2-A10-T06 host wiring (AC12, AC13)", () => {
  it("frames: ping gets its pong, control frames are not input, a rejected frame is, data reaches the snapshot; observe and signal", async () => {
    const server = await localServer();
    const dirs = await directories();
    const observations: P2HostObservation[] = [];
    let releaseProbe = () => {};
    hook.probeGate = new Promise<void>((done) => { releaseProbe = done; });
    const host = await start(server.url, dirs, observations);
    const stream = await events(host.displayPort);
    await until(() => server.sockets.length === 1 && stream.snapshots.length >= 1);
    // Startup publishes the checking snapshot first; the probe result changes it afterwards.
    expect(stream.snapshots[0].channels).toEqual({ desktop: "checking", sound: "checking" });
    releaseProbe();
    await until(() => stream.snapshots.some((item) => item.channels.sound !== "checking" && item.channels.desktop !== "checking"));
    const [ws] = server.sockets;
    ws.send(JSON.stringify({ type: "start", socketId: 1, classifications: ["eew.forecast"] }));
    ws.send(JSON.stringify({ type: "ping", pingId: "ping-7" }));
    ws.send(JSON.stringify({ type: "surprise" }));
    await until(() => server.received.length === 1);
    expect(JSON.parse(server.received[0])).toEqual({ type: "pong", pingId: "ping-7" });
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes("unknown-control"));
    // Control frames are not input: after a tick has projected, lastInputAt is still null.
    await new Promise((done) => setTimeout(done, 1_300));
    expect((await snapshot(host.displayPort)).connection.lastInputAt).toBeNull();
    // A frame ingress rejects is still an input.
    ws.send("not json");
    await until(async () => (await snapshot(host.displayPort)).connection.lastInputAt != null);
    ws.send(dataFrame("VXSE43", vxse43));
    await until(async () => (await snapshot(host.displayPort)).current.eew.items.length > 0);
    await until(() => stream.snapshots.length >= 2);
    const times = (point: "T0" | "T1" | "T2" | "T3" | "T4") => observations.flatMap((o) =>
      o.kind === "marker" && o.point === point && (!("inputId" in o) || o.inputId === "input-2") ? [o.monotonicMs] : []);
    const decoded = () => observations.find((o) => o.kind === "decode" && o.inputId === "input-2");
    // T3/T4 carry no input id: take the first ones at or after this input's decode.
    const after = (point: "T3" | "T4", from: number) => times(point).find((time) => time >= from);
    await until(() => { const d = decoded(); const t3 = d?.kind === "decode" ? after("T3", d.endedMonotonicMs) : undefined;
      return t3 != null && after("T4", t3) != null && observations.some((o) => o.kind === "publishSerialization")
        && observations.some((o) => o.kind === "processing"); });
    const decode = decoded();
    if (decode?.kind !== "decode") throw new Error("decode observation missing");
    const t3 = after("T3", decode.endedMonotonicMs)!;
    const order = [times("T0")[0], times("T1")[0], times("T2")[0], decode.startedMonotonicMs, decode.endedMonotonicMs, t3, after("T4", t3)!];
    expect(order.every((value, index) => index === 0 || value >= order[index - 1])).toBe(true);
    expect(observations.some((o) => o.kind === "processing")).toBe(true);
    expect(observations.some((o) => o.kind === "publishSerialization")).toBe(true);
    // The termination signal reaches shutdownRuntime: the last published snapshot says stopped.
    process.emit("SIGTERM");
    await until(() => stream.snapshots.at(-1)?.connection.state === "stopped" && stream.snapshots.at(-1)?.worker.state === "stopped");
  });

  it("initial connection failure rejects without leaking the URL, and shutdownRuntime and the display server close", async () => {
    const [wsPort, displayPort, dirs] = [await freePort(), await freePort(), await directories()];
    const error = await startP2Host({ wsUrl: `ws://127.0.0.1:${wsPort}/?token=secret-value`, ...dirs, displayPort,
      clock, observe: null }).catch((rejected: Error) => rejected);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret-value");
    expect(await fileSystem.readdir(dirs.diagnosticDirectory)).toContain("shutdown-summary.json");
    await new Promise<void>((done, fail) => {
      const connection = connect(displayPort, "127.0.0.1", () => { connection.destroy(); fail(new Error("display server still open")); });
      connection.on("error", () => done());
    });
  });

  it("close and error frame: connectionLost then reconnecting, one connection again after exactly 5 s, none after stop()", async () => {
    const server = await localServer();
    const host = await start(server.url, await directories());
    await until(() => server.sockets.length === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    server.sockets[0].terminate();
    await until(async () => (await snapshot(host.displayPort)).connection.state === "reconnecting");
    vi.advanceTimersByTime(4_999);
    await new Promise((done) => setImmediate(done));
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await until(() => server.sockets.length === 2);
    await until(() => server.sockets[1].readyState === 1);
    // An error frame is treated as a close: the host drops the connection and reconnects after 5 s.
    server.sockets[1].send(JSON.stringify({ type: "error", error: { message: "server error", code: 4000 } }));
    await until(() => server.sockets[1].readyState === 3);
    vi.advanceTimersByTime(4_999);
    await new Promise((done) => setImmediate(done));
    expect(server.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await until(() => server.sockets.length === 3);
    await until(() => server.sockets[2].readyState === 1);
    await host.stop();
    vi.advanceTimersByTime(20_000);
    await new Promise((done) => setImmediate(done));
    expect(server.sockets).toHaveLength(3);
  });

  it("capacity rejection: stop own connection, record the boundary, reconnect only after the mailbox drained", async () => {
    const server = await localServer();
    const dirs = await directories();
    const observations: P2HostObservation[] = [];
    const host = await start(server.url, dirs, observations);
    await until(() => server.sockets.length === 1);
    // 130 small frames in one burst: 120 fill the normal lane, the 121st is rejected by itemLimit.
    for (let index = 0; index < 130; index++) server.sockets[0].send(junk());
    await until(() => server.sockets.length === 2);
    expect(observations.filter((o) => o.kind === "decode")).toHaveLength(120);
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes('"component":"host"'));
    const boundary = (await diagnostics(dirs.diagnosticDirectory)).split("\n").filter((line) => line.includes('"component":"host"'));
    expect(JSON.parse(boundary[0])).toMatchObject({ reason: "mailboxRejectedItemLimit", inputId: "input-120", count: 120 });
    // The event timestamp is the wall clock of the rejected frame's receive callback, i.e. the loss start.
    const t0 = observations.find((o) => o.kind === "marker" && o.point === "T0" && o.inputId === "input-121");
    if (t0?.kind !== "marker") throw new Error("T0 of the rejected input-121 missing");
    expect(Math.abs(JSON.parse(boundary[0]).timestamp - (EEW_AT + Math.trunc(t0.monotonicMs - base)))).toBeLessThanOrEqual(1);
    // Parser input past the boundary ends "reconnecting".
    await until(() => server.sockets[1].readyState === 1);
    server.sockets[1].send(junk());
    await until(async () => (await snapshot(host.displayPort)).connection.state === "connected");
  });

  it("stall: unfinished work for 5 s becomes stalled with an immediate heartbeat, progress makes it healthy again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = await localServer();
    const dirs = await directories();
    const host = await start(server.url, dirs);
    const stream = await events(host.displayPort);
    await until(() => server.sockets.length === 1);
    // The thread cannot run a tick while decoding, so the tick fires inside the unfinished item.
    hook.beforeDecode = () => { hook.beforeDecode = null; skew.ms += 5_000; vi.advanceTimersByTime(1_000); };
    server.sockets[0].send(junk());
    await until(() => stream.heartbeats.length === 1);
    expect(stream.heartbeats).toEqual(["stalled"]);
    // The same tick's drainDiagnostics reports the stop.
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes("mailboxStalled"));
    expect((await fetchJson<{ worker: string }>(host.displayPort, "/healthz")).worker).toBe("stalled");
    vi.advanceTimersByTime(1_000);
    await until(() => stream.heartbeats.length === 2);
    expect(stream.heartbeats).toEqual(["stalled", "healthy"]);
    expect((await fetchJson<{ worker: string }>(host.displayPort, "/healthz")).worker).toBe("healthy");
  });

  it("restart: the saved U-E generation is restored by a second host on the same directories", async () => {
    const server = await localServer();
    const dirs = await directories();
    const first = await start(server.url, dirs);
    await until(() => server.sockets.length === 1);
    server.sockets[0].send(dataFrame("VXSE43", vxse43));
    await until(async () => (await snapshot(first.displayPort)).persistence["U-E"]?.kind === "saved");
    const saved = (await snapshot(first.displayPort)).persistence["U-E"];
    expect(saved?.savedGeneration).toBeGreaterThan(0);
    await first.stop();
    const second = await start(server.url, dirs);
    const restored = await snapshot(second.displayPort);
    expect(restored.recovery["U-E"].kind).toBe("restored");
    expect(restored.persistence["U-E"]).toMatchObject({ currentGeneration: saved?.currentGeneration, savedGeneration: saved?.savedGeneration });
    expect(restored.current.eew.items.length).toBeGreaterThan(0);
  });

  it("sound asset base does not depend on cwd (compiled layout)", () => {
    const adapter = resolve("reconstruction/dist/src/notification-delivery/adapter.js");
    const path = execFileSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(adapter)}).resolveRepoPath("reconstruction/assets/sounds/weather-info.wav"))`],
      { cwd: tmpdir(), encoding: "utf8" });
    expect(path).toBe(resolve("reconstruction/assets/sounds/weather-info.wav"));
    expect(existsSync(path)).toBe(true);
  });
});
