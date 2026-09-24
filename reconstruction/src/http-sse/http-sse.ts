import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import type {
  DisplaySnapshot,
  DisplayVersion,
  DisplayWorkerView,
  HealthResponse,
  SnapshotHttpResponse,
  SseClientInput,
  SseClientState,
  SseEvent,
  SseTransition,
} from "../../contracts/p2-snapshot-sse.types";

// P2-SNAPSHOT-SSE-001 RES-02, DLV-01, DLV-02.
const CLIENT_LIMIT = 8;
const HEARTBEAT_MS = 15_000;
const SLOW_CLIENT_MS = 5_000;

type TraceMarker = Readonly<{ point: "T4"; clock: "node"; monotonicMs: number }>;

function version(snapshot: DisplaySnapshot): DisplayVersion {
  return { streamId: snapshot.streamId, semanticRevision: snapshot.semanticRevision, sequence: snapshot.sequence };
}

function handleSnapshot(latest: DisplaySnapshot | null): SnapshotHttpResponse {
  return latest == null
    ? { status: 503, contentType: "application/json", body: { reason: "snapshotUnavailable" } }
    : { status: 200, contentType: "application/json", body: latest };
}

// AC04: transport answering says nothing about the worker; ready only after the first snapshot.
function handleHealth(worker: DisplayWorkerView, latest: DisplayVersion | null): HealthResponse {
  return { status: 200, body: { transport: "ok", worker: worker.state, latestVersion: latest, ready: latest != null } };
}

// AC03: one pending snapshot per client; the 5 s window starts at the first false write and never extends.
function handleSse(client: SseClientState, input: SseClientInput, nowMonotonicMs: number): SseTransition {
  const idle = { state: client, write: null, close: false };
  if (client.closed) return idle;
  switch (input.kind) {
    case "event":
      if (!client.backpressured) return { state: client, write: input.event, close: false };
      // Heartbeats are dropped while blocked; snapshots replace the single waiting slot.
      return input.event.event === "snapshot" ? { ...idle, state: { ...client, waitingSnapshot: input.event.data } } : idle;
    case "writeResult":
      return input.writable || client.backpressured ? idle : { ...idle,
        state: { ...client, backpressured: true, blockedSinceMonotonicMs: client.blockedSinceMonotonicMs ?? nowMonotonicMs } };
    case "drain": {
      const waiting = client.waitingSnapshot;
      const state = { ...client, backpressured: false, waitingSnapshot: null, blockedSinceMonotonicMs: null };
      return { state, close: false,
        write: waiting == null ? null : { event: "snapshot", id: String(waiting.sequence), data: waiting } };
    }
    case "deadline":
      return client.blockedSinceMonotonicMs != null && nowMonotonicMs - client.blockedSinceMonotonicMs >= SLOW_CLIENT_MS
        ? { state: { ...client, closed: true, waitingSnapshot: null }, write: null, close: true } : idle;
    case "closed":
      return { state: { ...client, closed: true, waitingSnapshot: null }, write: null, close: false };
  }
}

// AC14: every field value is JSON text or a decimal id; no raw input string reaches an SSE line.
function frame(event: SseEvent, data: string = JSON.stringify(event.data)): string {
  if (event.event === "heartbeat") return `event: heartbeat\ndata: ${data}\n\n`;
  if (!/^\d+$/.test(event.id)) throw new RangeError("SSE id must be a decimal sequence");
  return `event: snapshot\nid: ${event.id}\ndata: ${data}\n\n`;
}

type Client = { response: ServerResponse; state: SseClientState; timer: NodeJS.Timeout | null };

type DisplayServerOptions = Readonly<{
  // AC14: P4 authentication does not exist yet, so only loopback binds are expressible.
  host: "127.0.0.1" | "::1";
  port: number;
  worker: DisplayWorkerView;
  onMarker?: (marker: TraceMarker, version: DisplayVersion) => void;
}>;

// The Node http owner of the latest snapshot and the ServerResponse objects (B11).
async function startDisplayServer(options: DisplayServerOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "::1") throw new RangeError("display server binds loopback only");
  let latest: DisplaySnapshot | null = null;
  let latestJson = "";
  let worker = options.worker;
  const clients = new Set<Client>();

  const deliver = (client: Client, input: SseClientInput) => {
    const transition = handleSse(client.state, input, performance.now());
    client.state = transition.state;
    if (transition.write != null) {
      const event = transition.write;
      // One serialization per published snapshot, shared by every client (AC13 accounting).
      const text = event.event === "snapshot" && event.data === latest ? frame(event, latestJson) : frame(event);
      const writable = client.response.write(text);
      if (event.event === "snapshot")
        options.onMarker?.({ point: "T4", clock: "node", monotonicMs: performance.now() }, version(event.data));
      deliver(client, { kind: "writeResult", writable });
    }
    if (transition.close) client.response.destroy();
    // The deadline follows state.blockedSinceMonotonicMs only; new events never move it.
    const blockedSince = client.state.blockedSinceMonotonicMs;
    if (blockedSince == null && client.timer != null) { clearTimeout(client.timer); client.timer = null; }
    if (blockedSince != null && client.timer == null && !client.state.closed)
      client.timer = setTimeout(() => {
        client.timer = null;
        deliver(client, { kind: "deadline" });
      }, Math.max(SLOW_CLIENT_MS - (performance.now() - blockedSince), 0) + 1);
  };

  const json = (response: ServerResponse, status: number, body: string) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0];
    if (request.method !== "GET") return json(response, 405, JSON.stringify({ reason: "methodNotAllowed" }));
    if (path === "/healthz")
      return json(response, 200, JSON.stringify(handleHealth(worker, latest == null ? null : version(latest)).body));
    if (path === "/snapshot") {
      const result = handleSnapshot(latest);
      return json(response, result.status, result.status === 200 ? latestJson : JSON.stringify(result.body));
    }
    if (path !== "/events") return json(response, 404, JSON.stringify({ reason: "notFound" }));
    if (clients.size >= CLIENT_LIMIT) return json(response, 503, JSON.stringify({ reason: "clientLimit" }));
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
      connection: "keep-alive" });
    response.flushHeaders();
    const client: Client = { response, timer: null,
      state: { backpressured: false, waitingSnapshot: null, blockedSinceMonotonicMs: null, closed: false } };
    clients.add(client);
    response.on("drain", () => deliver(client, { kind: "drain" }));
    response.on("close", () => {
      if (client.timer != null) clearTimeout(client.timer);
      deliver(client, { kind: "closed" });
      clients.delete(client);
    });
    if (latest != null) deliver(client, { kind: "event", event: { event: "snapshot", id: String(latest.sequence), data: latest } });
  });

  const heartbeat = () => {
    const data = { worker, latestVersion: latest == null ? null : version(latest), emittedAt: Date.now() };
    for (const client of clients) deliver(client, { kind: "event", event: { event: "heartbeat", data } });
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  if (address == null || typeof address === "string") throw new Error("display server has no TCP address");
  const interval = setInterval(heartbeat, HEARTBEAT_MS);
  interval.unref();

  return {
    server,
    port: address.port,
    clientCount: () => clients.size,
    // HTTP keeps only the latest snapshot (RES-01); older undelivered ones are replaced per client.
    publish(snapshot: DisplaySnapshot) {
      latest = snapshot;
      latestJson = JSON.stringify(snapshot);
      for (const client of clients) deliver(client, { kind: "event", event: { event: "snapshot", id: String(snapshot.sequence), data: snapshot } });
    },
    setWorker(next: DisplayWorkerView) { worker = next; },
    heartbeat,
    async close() {
      clearInterval(interval);
      for (const client of clients) client.response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export { handleHealth, handleSnapshot, handleSse, startDisplayServer };
