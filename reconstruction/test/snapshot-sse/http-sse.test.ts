import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { Agent } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplaySnapshot, DisplayWorkerView } from "../../contracts/p2-snapshot-sse.types";
import type { WeatherTimeseriesSubject } from "../../contracts/p2-weather-timeseries-unit.types";
import { startDisplayServer } from "../../src/http-sse/http-sse";
import { toWeatherTimeseriesView } from "../../src/units/weather-timeseries/weather-timeseries-unit";
import { projectSnapshot } from "../../src/view-projector/view-projector";
import { allSubjects, decode, eewReport, projected, projectionInput, received, startup, step } from "./projection-fixture";

const at = 1780650000000;
const clock = { wallTimeMs: at, monotonicMs: 1 };
const healthy: DisplayWorkerView = { state: "healthy", lastProgressAtMonotonicMs: 1, lastResponseAtMonotonicMs: 1 };
const started = startup(clock);
const servers: Awaited<ReturnType<typeof startDisplayServer>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
});

async function serve() {
  const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy });
  servers.push(server);
  return server;
}

// A legal (<= 1 MiB, all full) snapshot of about 1 MB: one U-F series with a long area name.
let largeSnapshot: DisplaySnapshot | null = null;
function large(sequence: number): DisplaySnapshot {
  largeSnapshot ??= buildLarge();
  return { ...largeSnapshot, sequence };
}
function buildLarge(): DisplaySnapshot {
  const base = step(started.state, received("run", decode("81_02_01_260605_VPWP50_high_severity", "VPWP50"), clock)).state;
  const subject = base.units["U-F"].subjects[0];
  const strings = [...subject.strings];
  strings[subject.areas[0].name!] = "x".repeat(1_000_000);
  const series: WeatherTimeseriesSubject = { ...subject, strings };
  const units = { ...base.units, "U-F": { ...base.units["U-F"], subjects: [series] } };
  const state = { ...base, units, views: { ...base.views,
    "U-F": { ...toWeatherTimeseriesView(units["U-F"]), admission: {}, contentRevision: "1:0" } } };
  const result = projected(projectSnapshot(projectionInput({ state, outcomes: [], displayChanges: allSubjects(state),
    admissionCounts: started.admissionCounts }, at), null));
  expect(result.snapshot.current.weatherTimeseries.delivery).toBe("full");
  return result.snapshot;
}

type Stream = { response: IncomingMessage; frames: string[] };

function open(port: number, paused = false): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/events", agent: false }, (response) => {
      const stream: Stream = { response, frames: [] };
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) { stream.frames.push(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      });
      response.on("error", () => {});
      if (paused) response.pause();
      resolve(stream);
    });
    request.on("error", reject);
  });
}

// A reading SSE client that discards frames (no parsing work on the measured event loop).
function sink(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/events", agent: false }, (response) => {
      response.on("error", () => {});
      response.resume();
      resolve(response);
    }).on("error", reject);
  });
}

function fetchText(port: number, path: string, agent: Agent | false = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path, agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sequences = (stream: Stream) => stream.frames.filter((frame) => frame.startsWith("event: snapshot"))
  .map((frame) => (JSON.parse(frame.split("\n")[2].slice("data: ".length)) as DisplaySnapshot).sequence);

describe("P2-A8-T02 contractBoundary (AC03/AC14)", () => {
  it("P2-A8-T02: loopback only, 8 clients then 503, each gets the latest snapshot as JSON-framed SSE", async () => {
    // The runtime guard backs the type: a non-loopback host is refused before listening.
    // @ts-expect-error host is typed loopback-only
    await expect(startDisplayServer({ host: "0.0.0.0", port: 0, worker: healthy })).rejects.toThrow(RangeError);
    const server = await serve();
    expect(server.server.address()).toMatchObject({ address: "127.0.0.1" });
    const injected = "s\n\nevent: injected\r\ndata: {}";
    const snapshot = projected(projectSnapshot(projectionInput(started, at, { streamId: injected }), null)).snapshot;
    server.publish(snapshot);
    const clients = await Promise.all(Array.from({ length: 8 }, () => open(server.port)));
    await until(() => clients.every((client) => client.frames.length === 1));
    const ninth = await fetchText(server.port, "/events");
    expect(ninth).toEqual({ status: 503, body: JSON.stringify({ reason: "clientLimit" }) });
    for (const client of clients) {
      const lines = client.frames[0].split("\n");
      expect(lines).toHaveLength(3);
      expect(lines.slice(0, 2)).toEqual(["event: snapshot", "id: 1"]);
      expect(JSON.parse(lines[2].slice("data: ".length))).toEqual(snapshot);
    }
  });

  it("P2-A8-T02: after write() returns false only the newest waiting snapshot follows drain; written bytes are intact", async () => {
    const server = await serve();
    const client = await open(server.port, true);
    const [a, b, c, d] = [1, 2, 3, 4].map(large);
    server.publish(a);
    server.publish(b);
    server.publish(c);
    server.publish(d);
    client.response.resume();
    await until(() => client.frames.length === 2);
    expect(sequences(client)).toEqual([1, 4]);
    expect(JSON.parse(client.frames[0].split("\n")[2].slice("data: ".length))).toEqual(a);
  });

  it("P2-A8-T02: a client that never drains is closed 5000 ms after its last false write; later events do not extend it", async () => {
    const writes: number[] = [];
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy,
      onMarker: (marker) => writes.push(marker.monotonicMs) });
    servers.push(server);
    const client = await open(server.port, true);
    // Keep publishing (and heartbeating) until kernel buffers are full and the write stays blocked.
    let published = 0;
    const events: number[] = [];
    const load = setInterval(() => {
      events.push(performance.now());
      server.publish(large(++published));
      if (published % 5 === 0) server.heartbeat();
    }, 100);
    // A paused client never reads the FIN, so the server-side release is the observable close.
    await until(() => server.clientCount() === 0, 20_000);
    const closedAt = performance.now();
    clearInterval(load);
    client.response.destroy();
    const blockedAt = writes[writes.length - 1];
    expect(closedAt - blockedAt).toBeGreaterThanOrEqual(4_990);
    expect(closedAt - blockedAt).toBeLessThan(6_000);
    // Publishes/heartbeats arrived after the blocking write, yet the deadline was not extended.
    expect(events.filter((time) => time > blockedAt).length).toBeGreaterThanOrEqual(1);
  });
});

describe("P2-A8-T03 regression (AC04)", () => {
  it("P2-A8-T03: heartbeats carry a stopped worker without advancing sequence or sending snapshots; health stays honest", async () => {
    const server = await serve();
    expect(JSON.parse((await fetchText(server.port, "/healthz")).body)).toEqual({ transport: "ok", worker: "healthy",
      latestVersion: null, ready: false });
    expect(await fetchText(server.port, "/snapshot")).toEqual({ status: 503, body: JSON.stringify({ reason: "snapshotUnavailable" }) });
    const snapshot = projected(projectSnapshot(projectionInput(started, at), null)).snapshot;
    server.publish(snapshot);
    const client = await open(server.port);
    await until(() => client.frames.length === 1);
    const stopped: DisplayWorkerView = { state: "stopped", lastProgressAtMonotonicMs: 1, lastResponseAtMonotonicMs: 2 };
    server.setWorker(stopped);
    server.heartbeat();
    server.heartbeat();
    await until(() => client.frames.length === 3);
    const version = { streamId: "stream", semanticRevision: snapshot.semanticRevision, sequence: 1 };
    for (const frame of client.frames.slice(1)) {
      const lines = frame.split("\n");
      expect(lines[0]).toBe("event: heartbeat");
      expect(JSON.parse(lines[1].slice("data: ".length))).toMatchObject({ worker: stopped, latestVersion: version });
    }
    expect(sequences(client)).toEqual([1]);
    expect(JSON.parse((await fetchText(server.port, "/healthz")).body)).toEqual({ transport: "ok", worker: "stopped",
      latestVersion: version, ready: true });
  });
});

describe("P2-A8-T04 acceptance (AC05)", () => {
  it("P2-A8-T04: /healthz transport latency and worker judgement are tallied separately (not the formal E02 run)", async () => {
    const server = await serve();
    server.publish(large(1));
    const listeners = await Promise.all(Array.from({ length: 7 }, () => sink(server.port)));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const latencies: number[] = [];
    const workers: Record<string, number> = {};
    for (let index = 0; index < 120; index++) {
      if (index % 10 === 0) server.publish(large(index + 2));
      if (index === 60) server.setWorker({ ...healthy, state: "unresponsive" });
      const start = performance.now();
      const { status, body } = await fetchText(server.port, "/healthz", agent);
      latencies.push(performance.now() - start);
      const parsed = JSON.parse(body) as { transport: string; worker: string };
      expect([status, parsed.transport]).toEqual([200, "ok"]);
      workers[parsed.worker] = (workers[parsed.worker] ?? 0) + 1;
    }
    agent.destroy();
    for (const listener of listeners) listener.destroy();
    // Too few samples is never a pass.
    expect(latencies.length).toBeGreaterThanOrEqual(100);
    const sorted = [...latencies].sort((left, right) => left - right);
    const p99 = sorted[Math.ceil(sorted.length * 0.99) - 1];
    console.info(JSON.stringify({ test: "P2-A8-T04", samples: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p99, workers }));
    expect(workers).toEqual({ healthy: 60, unresponsive: 60 });
    expect(p99).toBeLessThanOrEqual(100);
  });
});

describe("P2-A8-T05 / AC07 and P2-A8-T06 / AC13 on the HTTP side", () => {
  it("P2-A8-T05 / AC07: the T4 marker is emitted when a corpus EEW snapshot is handed to the SSE writer", async () => {
    const markers: unknown[] = [];
    const server = await startDisplayServer({ host: "127.0.0.1", port: 0, worker: healthy,
      onMarker: (marker, version) => markers.push({ ...marker, version }) });
    servers.push(server);
    const first = projected(projectSnapshot(projectionInput(started, at), null));
    const adopted = step(started.state, received("run", eewReport("20240417231454"), clock));
    const result = projected(projectSnapshot(projectionInput(adopted, at), first.state));
    server.publish(result.snapshot);
    const client = await open(server.port);
    await until(() => client.frames.length === 1);
    expect(markers).toEqual([{ point: "T4", clock: "node", monotonicMs: expect.any(Number),
      version: { streamId: "stream", semanticRevision: result.snapshot.semanticRevision, sequence: 2 } }]);
  });

  it("P2-A8-T06 / AC13: a publish serializes the snapshot once, whatever the number of clients", async () => {
    const server = await serve();
    const clients = await Promise.all(Array.from({ length: 3 }, () => open(server.port)));
    const snapshot = large(1);
    const stringify = vi.spyOn(JSON, "stringify");
    server.publish(snapshot);
    expect(stringify.mock.calls.filter(([value]) => value === snapshot)).toHaveLength(1);
    stringify.mockRestore();
    await until(() => clients.every((client) => client.frames.length === 1));
  });
});
