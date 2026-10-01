import { execFileSync } from "node:child_process";
import { existsSync, promises as fileSystem, readFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { DmdataSubscription } from "../../contracts/p3-dmdata-connect.types";
import type { DmdataSocket, SocketCloseResult, SocketListResult, SocketStartResult } from "../../src/host/dmdata-rest";
import { startP2Host } from "../../src/host/host";
import type { P2HostConfig } from "../../src/host/host";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";

const hook = vi.hoisted(() => ({ beforeDecode: null as (() => void) | null, probeGate: null as Promise<void> | null }));
// P3-C2-AC09: no test reaches dmdata. Every host REST call goes to the test's handler; a call without one fails the test.
const rest = vi.hoisted(() => ({
  list: null as ((status: "open" | "waiting") => Promise<SocketListResult>) | null,
  close: null as ((id: number) => Promise<SocketCloseResult>) | null,
  start: null as ((signal?: AbortSignal) => Promise<SocketStartResult>) | null,
  calls: [] as string[],
  subscriptions: [] as DmdataSubscription[],
  unmocked: [] as string[],
}));
vi.mock("../../src/host/dmdata-rest", () => {
  const unmocked = (name: string) => { rest.unmocked.push(name); return Promise.resolve({ kind: "failed" as const }); };
  return {
    listSockets: (_apiKey: string, status: "open" | "waiting") => { rest.calls.push(`list:${status}`); return rest.list?.(status) ?? unmocked("list"); },
    closeSocket: (_apiKey: string, id: number) => { rest.calls.push(`delete:${id}`); return rest.close?.(id) ?? unmocked("delete"); },
    startSocket: (subscription: DmdataSubscription, signal?: AbortSignal) => {
      rest.calls.push("start");
      rest.subscriptions.push(subscription);
      return rest.start?.(signal) ?? unmocked("start");
    },
  };
});
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
  const unmocked = rest.unmocked.splice(0);
  Object.assign(rest, { list: null, close: null, start: null, calls: [], subscriptions: [] });
  expect(unmocked).toEqual([]);
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
    // 130 small frames in one burst fill the 120-item normal lane; a frame arriving after that is rejected by itemLimit.
    // The burst may reach the host over several turns, so the pump can take a few items first (CI saw 121 accepted).
    for (let index = 0; index < 130; index++) server.sockets[0].send(junk());
    await until(() => server.sockets.length === 2);
    const decodedBeforeReconnect = observations.filter((o) => o.kind === "decode").length;
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes('"component":"host"'));
    const boundary = (await diagnostics(dirs.diagnosticDirectory)).split("\n").filter((line) => line.includes('"component":"host"'));
    const { count } = JSON.parse(boundary[0]) as { count: number };
    expect(count).toBeGreaterThanOrEqual(120);
    expect(JSON.parse(boundary[0])).toMatchObject({ reason: "mailboxRejectedItemLimit", inputId: `input-${count}` });
    // Reconnect only after every accepted input was drained.
    expect(decodedBeforeReconnect).toBe(count);
    // The event timestamp is the wall clock of the rejected frame's receive callback, i.e. the loss start.
    const t0 = observations.find((o) => o.kind === "marker" && o.point === "T0" && o.inputId === `input-${count + 1}`);
    if (t0?.kind !== "marker") throw new Error(`T0 of the rejected input-${count + 1} missing`);
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

const subscription: DmdataSubscription = { apiKey: "KEY-SECRET-2", appName: "fleq-p3-test", classifications: ["eew.forecast", "eew.warning"] };
const socketOf = (id: number, appName: string | null, status = "open"): DmdataSocket => ({ id, appName, status, classifications: ["eew.forecast"] });
const listing = (open: readonly DmdataSocket[], waiting: readonly DmdataSocket[] = []) =>
  async (status: "open" | "waiting"): Promise<SocketListResult> => ({ kind: "ok", sockets: status === "open" ? open : waiting });
const failed = async () => ({ kind: "failed" as const });
const opened = (url: string, id: number) => async (): Promise<SocketStartResult> => ({ kind: "ok", id, url, protocol: ["dmdata.v2"] });
const deletes = () => rest.calls.filter((call) => call.startsWith("delete:"));
const turn = () => new Promise((done) => setImmediate(done));
// Real time while setTimeout is faked (the host tick stays a real setInterval).
const pause = (milliseconds: number) => { const end = performance.now() + milliseconds; return until(() => performance.now() >= end, milliseconds + 1_000); };

async function startDmdata(dirs: Awaited<ReturnType<typeof directories>>, observations: P2HostObservation[] = []) {
  const host = await startP2Host({ dmdata: subscription, ...dirs, displayPort: 0, clock, observe: (o) => { observations.push(o); } });
  cleanups.push(() => host.stop().then(() => {}, () => {}));
  return host;
}
type HostLine = { level: string; reason: string; count?: number; durationMs?: number };
async function hostLines(dir: string): Promise<HostLine[]> {
  return (await diagnostics(dir)).split("\n").filter((line) => line.includes('"component":"host"')).map((line): HostLine => JSON.parse(line));
}
async function firstLine(dir: string, reason: string): Promise<HostLine> {
  await until(async () => (await hostLines(dir)).some((line) => line.reason === reason));
  return (await hostLines(dir)).find((line) => line.reason === reason)!;
}
// WARN and ERROR carry neither count nor durationMs (AC05).
function expectBare(line: HostLine, level: "WARN" | "ERROR"): void {
  expect(line.level).toBe(level);
  expect(line).not.toHaveProperty("count");
  expect(line).not.toHaveProperty("durationMs");
}
// Waits until the host has handled the close (dispatchLost and the reconnect timer happen together).
// disconnectedAt has 1 ms resolution and a fake-timer reconnect can follow the previous loss within that millisecond,
// so the test clock moves 1 s first: each loss then has its own disconnectedAt and its own snapshot.
async function lose(port: number, ws: WebSocket): Promise<void> {
  const before = (await snapshot(port)).connection.disconnectedAt;
  skew.ms += 1_000;
  ws.terminate();
  await until(async () => (await snapshot(port)).connection.disconnectedAt !== before);
}
function refused(port: number): Promise<void> {
  return new Promise<void>((done, fail) => {
    const connection = connect(port, "127.0.0.1", () => { connection.destroy(); fail(new Error("display server open")); });
    connection.on("error", () => done());
  });
}

describe("P3-DMDATA-CONNECT-001 live dmdata entry, connection and liveness", () => {
  it("P3-C2-T01: { dmdata } lists then starts, opens the start URL with its subprotocol, records start; data reaches the snapshot after T0", async () => {
    const server = await localServer();
    const dirs = await directories();
    const observations: P2HostObservation[] = [];
    rest.list = listing([socketOf(3, "fleq")]);
    rest.start = opened(server.url, 41);
    rest.close = async () => ({ kind: "ok" });
    const host = await startDmdata(dirs, observations);
    expect(rest.calls).toEqual(["list:open", "list:waiting", "start"]);
    expect(rest.subscriptions).toEqual([subscription]);
    await until(() => server.sockets.length === 1);
    expect(server.sockets[0].protocol).toBe("dmdata.v2");
    // dmdata granted eew.forecast only: eew.warning is narrowed away.
    server.sockets[0].send(JSON.stringify({ type: "start", socketId: 41, classifications: ["eew.forecast"] }));
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataSubscriptionNarrowed"), "WARN");
    expect((await hostLines(dirs.diagnosticDirectory)).filter((line) => line.reason === "dmdataSocketStarted"))
      .toEqual([expect.objectContaining({ level: "INFO", count: 41 })]);
    expect(observations.filter((o) => o.kind === "controlFrame")).toEqual([expect.objectContaining({ frameType: "start", errorClose: null })]);
    server.sockets[0].send(dataFrame("VXSE43", vxse43));
    await until(async () => (await snapshot(host.displayPort)).current.eew.items.length > 0);
    const t0 = observations.find((o) => o.kind === "marker" && o.point === "T0");
    const decode = observations.find((o) => o.kind === "decode");
    if (t0?.kind !== "marker" || decode?.kind !== "decode") throw new Error("T0 or decode observation missing");
    expect(t0.monotonicMs).toBeLessThanOrEqual(decode.startedMonotonicMs);
  });

  it("P3-C2-T01: an invalid subscription rejects before the display server and REST; appName fleq rejects before REST; the sources are exclusive", async () => {
    const dirs = await directories();
    // The port is taken: a display server started before the check would fail with another error.
    const taken = createServer().listen(0, "127.0.0.1");
    await new Promise((done) => taken.once("listening", done));
    cleanups.push(() => new Promise<void>((done) => taken.close(() => done())));
    const invalid: DmdataSubscription[] = [{ ...subscription, classifications: [] }, { ...subscription, apiKey: " " },
      { ...subscription, classifications: ["eew.forecast", "eew.forecast"] },
      // @ts-expect-error an unknown classification is the input under test
      { ...subscription, classifications: ["telegram.unknown"] }];
    for (const dmdata of invalid) {
      const error = await startP2Host({ dmdata, ...dirs, displayPort: (taken.address() as AddressInfo).port, clock, observe: null })
        .catch((rejected: Error) => rejected);
      expect((error as Error).message).toBe("invalid dmdata subscription");
    }
    const displayPort = await freePort();
    const error = await startP2Host({ dmdata: { ...subscription, appName: "fleq" }, ...dirs, displayPort, clock, observe: null })
      .catch((rejected: Error) => rejected);
    expect((error as Error).message).toBe("new and legacy appName must differ");
    await refused(displayPort);
    expect(rest.calls).toEqual([]);
    // @ts-expect-error { wsUrl } and { dmdata } cannot both be given
    const both: P2HostConfig = { wsUrl: "ws://127.0.0.1:1/", dmdata: subscription, ...dirs, displayPort: 0, clock, observe: null };
    expect(both).toBeDefined();
  });

  it("P3-C2-T02: only the own socket is closed, before the next start; a released id is not counted; a vanished id is forgotten; stop() closes the own socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await localServer();
    const dirs = await directories();
    // Another process with the same appName, another app, and a waiting socket: counted, never closed.
    const others = [socketOf(7, subscription.appName), socketOf(8, "other-app")];
    let own: DmdataSocket[] = [];
    let nextId = 21;
    rest.list = async (status) => ({ kind: "ok", sockets: status === "open" ? [...others, ...own] : [socketOf(9, null, "waiting")] });
    rest.start = async () => {
      const id = nextId++;
      own = [socketOf(id, subscription.appName)];
      return { kind: "ok", id, url: server.url, protocol: ["dmdata.v2"] };
    };
    rest.close = async (id) => { own = own.filter((item) => item.id !== id); return { kind: "ok" }; };
    const host = await startDmdata(dirs);
    const reconnect = async (index: number) => {
      await until(() => server.sockets.length === index + 1 && server.sockets[index].readyState === 1);
      // The pong shows the host side has opened too; a close before that is a handshake failure, not a loss.
      server.sockets[index].send(JSON.stringify({ type: "ping", pingId: `p${index}` }));
      await until(() => server.received.length === index + 1);
      await lose(host.displayPort, server.sockets[index]);
      vi.advanceTimersByTime(5_000);
      await until(() => server.sockets.length === index + 2 && server.sockets[index + 1].readyState === 1);
      expect(server.sockets.filter((ws) => ws.readyState === 1)).toHaveLength(1);
    };
    // Own 21 is listed: it is closed before the next start, and not counted (3 others + 21 + 1 would be 5).
    await reconnect(0);
    expect(rest.calls.slice(3)).toEqual(["list:open", "list:waiting", "delete:21", "start"]);
    // dmdata no longer lists 22: no DELETE, straight to start.
    own = [];
    await reconnect(1);
    expect(rest.calls.slice(7)).toEqual(["list:open", "list:waiting", "start"]);
    await host.stop();
    expect(deletes()).toEqual(["delete:21", "delete:23"]);
    expect(server.sockets.every((ws) => ws.readyState !== 1)).toBe(true);
  });

  const failures: { name: string; reason: string; list: (status: "open" | "waiting") => Promise<SocketListResult>;
    start?: () => Promise<SocketStartResult> }[] = [
    { name: "the open list fails", reason: "dmdataSocketListFailed",
      list: async (status) => status === "open" ? { kind: "failed" } : { kind: "ok", sockets: [] } },
    { name: "the waiting list fails", reason: "dmdataSocketListFailed",
      list: async (status) => status === "waiting" ? { kind: "failed" } : { kind: "ok", sockets: [] } },
    { name: "four waiting sockets fill the capacity", reason: "dmdataConnectionCapacityExceeded",
      list: listing([], [1, 2, 3, 4].map((id) => socketOf(id, "other-app", "waiting"))) },
    { name: "the start fails", reason: "dmdataSocketStartFailed", list: listing([]), start: failed },
  ];
  it.each(failures)("P3-C2-T02: when $name: one WARN, no reject, reconnecting, then the next attempts 60 s apart", async ({ reason, list, start }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dirs = await directories();
    rest.list = list;
    rest.start = start ?? null;
    const host = await startDmdata(dirs);
    const perAttempt = rest.calls.length;
    await until(async () => (await snapshot(host.displayPort)).connection.state === "reconnecting");
    expectBare(await firstLine(dirs.diagnosticDirectory, reason), "WARN");
    for (const attempt of [2, 3]) {
      await turn();
      vi.advanceTimersByTime(59_999);
      await turn();
      expect(rest.calls).toHaveLength(perAttempt * (attempt - 1));
      vi.advanceTimersByTime(1);
      await until(() => rest.calls.length === perAttempt * attempt);
    }
  });

  it("P3-C2-T02: a failed DELETE of the listed own socket writes one WARN and starts nothing until the retry 60 s later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await localServer();
    const dirs = await directories();
    let own: DmdataSocket[] = [];
    let nextId = 31;
    rest.list = async (status) => ({ kind: "ok", sockets: status === "open" ? own : [] });
    rest.start = async () => { own = [socketOf(nextId, subscription.appName)]; return { kind: "ok", id: nextId++, url: server.url, protocol: ["dmdata.v2"] }; };
    rest.close = failed;
    const host = await startDmdata(dirs);
    await until(() => server.sockets.length === 1 && server.sockets[0].readyState === 1);
    await lose(host.displayPort, server.sockets[0]);
    vi.advanceTimersByTime(5_000);
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataSocketCloseFailed"), "WARN");
    expect(rest.calls.slice(3)).toEqual(["list:open", "list:waiting", "delete:31"]);
    rest.close = async () => { own = []; return { kind: "ok" }; };
    await turn();
    vi.advanceTimersByTime(59_999);
    await turn();
    expect(rest.calls).toHaveLength(6);
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await until(() => server.sockets.length === 2);
    expect(rest.calls.slice(6)).toEqual(["list:open", "list:waiting", "delete:31", "start"]);
  });

  it("P3-C2-T02: 401/403 write one ERROR and stop retrying; on the first attempt startP2Host rejects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await directories();
    rest.list = async () => ({ kind: "authRejected" });
    const error = await startP2Host({ dmdata: subscription, ...first, displayPort: 0, clock, observe: null }).catch((rejected: Error) => rejected);
    expect((error as Error).message).toBe("dmdata authentication rejected");
    const rejections = (await hostLines(first.diagnosticDirectory)).filter((line) => line.reason === "dmdataAuthRejected");
    expect(rejections).toHaveLength(1);
    expectBare(rejections[0], "ERROR");
    // On a reconnect the 401/403 ends the retries; startP2Host had already returned.
    const server = await localServer();
    const dirs = await directories();
    rest.list = listing([]);
    rest.start = opened(server.url, 45);
    rest.close = async () => ({ kind: "ok" });
    const host = await startDmdata(dirs);
    await until(() => server.sockets.length === 1 && server.sockets[0].readyState === 1);
    rest.list = async () => ({ kind: "authRejected" });
    await lose(host.displayPort, server.sockets[0]);
    vi.advanceTimersByTime(5_000);
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataAuthRejected"), "ERROR");
    const calls = rest.calls.length;
    await turn();
    vi.advanceTimersByTime(600_000);
    await turn();
    expect(rest.calls).toHaveLength(calls);
  });

  it("P3-C2-T02: stop() while the start answer is pending opens no WS and closes the id the answer returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await localServer();
    rest.list = failed;
    const host = await startDmdata(await directories());
    let answer: (result: SocketStartResult) => void = () => {};
    rest.list = listing([]);
    rest.start = () => new Promise((done) => { answer = done; });
    rest.close = async () => ({ kind: "ok" });
    await turn();
    vi.advanceTimersByTime(60_000);
    await until(() => rest.calls.includes("start"));
    const stopped = host.stop();
    answer({ kind: "ok", id: 51, url: server.url, protocol: ["dmdata.v2"] });
    await stopped;
    await turn();
    expect(server.sockets).toHaveLength(0);
    expect(deletes()).toEqual(["delete:51"]);
  });

  it("P3-C2-T07: an uncertain start writes one WARN and opens no WS without rejecting; the retry 60 s later decides by capacity alone and never adopts or closes an unreturned socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dirs = await directories();
    rest.list = listing([]);
    rest.start = async () => ({ kind: "uncertain" });
    const host = await startDmdata(dirs);
    await until(async () => (await snapshot(host.displayPort)).connection.state === "reconnecting");
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataSocketStartUncertain"), "WARN");
    expect((await hostLines(dirs.diagnosticDirectory)).filter((line) => line.reason === "dmdataSocketStartUncertain")).toHaveLength(1);
    // The uncertain POST may have left a waiting socket with this appName: counted, never taken as the own one.
    const leftover = socketOf(61, subscription.appName, "waiting");
    rest.list = listing([socketOf(7, "a"), socketOf(8, "b")], [leftover]);
    rest.start = failed;
    await turn();
    vi.advanceTimersByTime(59_999);
    await turn();
    expect(rest.calls).toHaveLength(3);
    vi.advanceTimersByTime(1);
    await until(() => rest.calls.length === 6);
    expect(rest.calls.slice(3)).toEqual(["list:open", "list:waiting", "start"]);
    rest.list = listing([socketOf(7, "a"), socketOf(8, "b"), socketOf(9, "c")], [leftover]);
    await turn();
    vi.advanceTimersByTime(60_000);
    await firstLine(dirs.diagnosticDirectory, "dmdataConnectionCapacityExceeded");
    expect(rest.calls.slice(6)).toEqual(["list:open", "list:waiting"]);
    await host.stop();
    expect(deletes()).toEqual([]);
  });

  it("P3-C2-T05: apiKey, ticket and ipAddress reach no diagnostic, snapshot, rejection or observation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await localServer();
    const dirs = await directories();
    const observations: P2HostObservation[] = [];
    const secret = { apiKey: "KEY-SECRET-5", ticket: "TICKET-SECRET-5", ipAddress: "203.0.113.55" };
    const leaky = { ...socketOf(3, "fleq"), ticket: secret.ticket, ipAddress: secret.ipAddress };
    const dmdata = { ...subscription, apiKey: secret.apiKey };
    rest.list = listing([leaky]);
    rest.start = opened(`${server.url}&ticket=${secret.ticket}`, 71);
    rest.close = failed;
    const host = await startP2Host({ dmdata, ...dirs, displayPort: 0, clock, observe: (o) => { observations.push(o); } });
    cleanups.push(() => host.stop().then(() => {}, () => {}));
    await until(() => server.sockets.length === 1 && server.sockets[0].readyState === 1);
    server.sockets[0].send(JSON.stringify({ type: "start", socketId: 71, classifications: ["eew.forecast", "eew.warning"] }));
    server.sockets[0].send(dataFrame("VXSE43", vxse43));
    await until(async () => (await snapshot(host.displayPort)).current.eew.items.length > 0);
    // An error frame (close flag recorded), a failed DELETE of the listed own socket, then an uncertain start.
    server.sockets[0].send(JSON.stringify({ type: "error", error: { message: secret.ticket, code: 4808 }, close: true }));
    await until(async () => (await snapshot(host.displayPort)).connection.disconnectedAt != null);
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataErrorFrame"), "WARN");
    rest.list = listing([leaky, socketOf(71, dmdata.appName)]);
    vi.advanceTimersByTime(5_000);
    await firstLine(dirs.diagnosticDirectory, "dmdataSocketCloseFailed");
    rest.list = listing([leaky]);
    rest.close = async () => ({ kind: "ok" });
    rest.start = async () => ({ kind: "uncertain" });
    await turn();
    vi.advanceTimersByTime(60_000);
    await firstLine(dirs.diagnosticDirectory, "dmdataSocketStartUncertain");
    const shown = JSON.stringify(await snapshot(host.displayPort));
    await host.stop();
    rest.list = async () => ({ kind: "authRejected" });
    const rejected = await startP2Host({ dmdata, ...(await directories()), displayPort: 0, clock, observe: null })
      .then(() => "resolved", (error: Error) => `${error.message} ${String(error.stack)}`);
    expect(observations.flatMap((o) => o.kind === "controlFrame" ? [[o.frameType, o.errorClose]] : []))
      .toEqual([["start", null], ["error", true]]);
    for (const text of [await diagnostics(dirs.diagnosticDirectory), shown, JSON.stringify(observations), rejected])
      for (const value of Object.values(secret)) expect(text).not.toContain(value);
  });

  it("P3-C2-T09: stop() during a pending start begins shutdownRuntime at once with the stop request clock; at +30 s the REST in flight is destroyed and none starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const shutdown = vi.spyOn(RuntimeCompositionRoot.prototype, "shutdownRuntime");
    cleanups.push(() => shutdown.mockRestore());
    // A host whose reconnect attempt waits on a POST that does not answer by itself.
    const pendingStart = async () => {
      const dirs = await directories();
      rest.list = failed;
      const host = await startDmdata(dirs);
      rest.list = listing([]);
      const request: { answer: (result: SocketStartResult) => void; signal: AbortSignal | undefined } = { answer: () => {}, signal: undefined };
      rest.start = (signal) => new Promise((done) => { request.answer = done; request.signal = signal; });
      rest.close = async () => ({ kind: "ok" });
      await turn();
      vi.advanceTimersByTime(60_000);
      await until(() => rest.calls.includes("start"));
      return { dirs, host, request };
    };
    const { dirs, host, request } = await pendingStart();
    const requestedAt = clock().wallTimeMs;
    let settled = false;
    const stopped = host.stop().then((summary) => { settled = true; return summary; });
    // A clock read after the cleanup would be 2 s later.
    skew.ms += 2_000;
    // shutdownRuntime already started inside stop(), with the stop request clock.
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown.mock.calls[0][2].wallTimeMs - requestedAt).toBeGreaterThanOrEqual(0);
    expect(shutdown.mock.calls[0][2].wallTimeMs - requestedAt).toBeLessThan(2_000);
    // It completes, every stage in time, while the cleanup still waits. Fake time moves only after that:
    // the shutdown stage deadlines are setTimeouts too, and advancing during a stage would cut it.
    const summary = await shutdown.mock.results[0].value;
    expect(summary.reasons).toEqual([]);
    expect(settled).toBe(false);
    vi.advanceTimersByTime(29_000);
    await turn();
    expect(settled).toBe(false);
    expect(request.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(await stopped).toBe(summary);
    // The POST still in flight is destroyed at the limit, not only left unwaited.
    expect(request.signal?.aborted).toBe(true);
    expectBare(await firstLine(dirs.diagnosticDirectory, "dmdataSocketCloseFailed"), "WARN");
    // An answer arriving anyway after the limit starts no DELETE (its socket stays, a known residual risk).
    const callsAtLimit = rest.calls.length;
    request.answer({ kind: "ok", id: 53, url: "ws://127.0.0.1:1/", protocol: ["dmdata.v2"] });
    await turn();
    expect(rest.calls).toHaveLength(callsAtLimit);
    // The monotonic clock is past the limit before the limit's timer has run: still no DELETE starts.
    const late = await pendingStart();
    const lateStopped = late.host.stop();
    await shutdown.mock.results[1].value;
    skew.ms += 31_000;
    late.request.answer({ kind: "ok", id: 54, url: "ws://127.0.0.1:1/", protocol: ["dmdata.v2"] });
    await lateStopped;
    expect(deletes()).toEqual([]);
  });

  it("P3-C2-T02: stop() in the turn right after the start answer opens no WS, and the returned id is closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = await localServer();
    rest.list = failed;
    const host = await startDmdata(await directories());
    let stopped: Promise<unknown> | null = null;
    rest.list = listing([]);
    rest.close = async () => ({ kind: "ok" });
    rest.start = () => {
      const answer = Promise.resolve<SocketStartResult>({ kind: "ok", id: 52, url: server.url, protocol: ["dmdata.v2"] });
      // One microtask after the answer: past the stop check that follows the start, before connect() goes on to the WS.
      void answer.then(() => {}).then(() => { stopped = host.stop(); });
      return answer;
    };
    await turn();
    vi.advanceTimersByTime(60_000);
    await until(() => stopped != null);
    await stopped;
    // Room for a WS that would still be opening to reach the server.
    await pause(300);
    expect(server.sockets).toHaveLength(0);
    expect(deletes()).toEqual(["delete:52"]);
  });

  it("P3-C2-T03: pings under 90 s keep the WS; 90 s without a frame cuts it with one WARN, reconnecting, and a new WS after 5 s", async () => {
    const server = await localServer();
    const dirs = await directories();
    const host = await start(server.url, dirs);
    await until(() => server.sockets.length === 1 && server.sockets[0].readyState === 1);
    skew.ms += 60_000;
    server.sockets[0].send(JSON.stringify({ type: "ping", pingId: "p1" }));
    await until(() => server.received.length === 1);
    skew.ms += 60_000;
    await new Promise((done) => setTimeout(done, 1_300));
    expect(server.sockets[0].readyState).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    skew.ms += 30_000;
    await until(() => server.sockets[0].readyState === 3);
    await until(async () => (await snapshot(host.displayPort)).connection.state === "reconnecting");
    expectBare(await firstLine(dirs.diagnosticDirectory, "connectionLivenessExpired"), "WARN");
    expect((await hostLines(dirs.diagnosticDirectory)).filter((line) => line.reason === "connectionLivenessExpired")).toHaveLength(1);
    vi.advanceTimersByTime(4_999);
    await turn();
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await until(() => server.sockets.length === 2);
  });

  it("P3-C2-T03: a server that never answers the upgrade fails the handshake after 15 s", async () => {
    const held: Socket[] = [];
    const tcp = createServer((connection) => { held.push(connection); });
    await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", () => done()));
    cleanups.push(() => new Promise<void>((done) => { for (const connection of held) connection.destroy(); tcp.close(() => done()); }));
    const begun = performance.now();
    const error = await startP2Host({ wsUrl: `ws://127.0.0.1:${(tcp.address() as AddressInfo).port}/`, ...(await directories()),
      displayPort: 0, clock, observe: null }).catch((rejected: Error) => rejected);
    expect((error as Error).message).toBe("WebSocket connection failed");
    expect(performance.now() - begun).toBeGreaterThanOrEqual(14_900);
  }, 25_000);

  it("P3-C2-T04: after a reconnect, open alone and a malformed start stay reconnecting; a valid start connects within a tick, recovery unchanged", async () => {
    const server = await localServer();
    const dirs = await directories();
    const host = await start(server.url, dirs);
    await until(() => server.sockets.length === 1 && server.sockets[0].readyState === 1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await lose(host.displayPort, server.sockets[0]);
    vi.advanceTimersByTime(5_000);
    await until(() => server.sockets.length === 2 && server.sockets[1].readyState === 1);
    await pause(1_300);
    const lost = await snapshot(host.displayPort);
    expect(lost.connection.state).toBe("reconnecting");
    server.sockets[1].send(JSON.stringify({ type: "start", socketId: "41", classifications: ["eew.forecast"] }));
    await until(async () => (await diagnostics(dirs.diagnosticDirectory)).includes("unknown-control"));
    await pause(1_300);
    expect((await snapshot(host.displayPort)).connection.state).toBe("reconnecting");
    server.sockets[1].send(JSON.stringify({ type: "start", socketId: 41, classifications: ["eew.forecast"] }));
    await until(async () => (await snapshot(host.displayPort)).connection.state === "connected", 2_000);
    const back = await snapshot(host.displayPort);
    expect(back.recovery).toEqual(lost.recovery);
    expect(back.connection).toEqual({ ...lost.connection, state: "connected" });
  });
});
