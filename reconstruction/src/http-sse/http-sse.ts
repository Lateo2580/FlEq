import { readFile } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIPv4, type AddressInfo } from "node:net";
import { join } from "node:path";
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
import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types";

// P2-SNAPSHOT-SSE-001 RES-02, DLV-01, DLV-02.
const CLIENT_LIMIT = 8;
const HEARTBEAT_MS = 15_000;
const SLOW_CLIENT_MS = 5_000;
// AC15: the name whitelist is the path check; `/`, `..` and percent-encoded separators cannot match.
const MODULE_PATH = /^\/chrome-eew\/([a-z0-9-]+)\.js$/;

// P3-UFP-AC08: U-F の詳細の口。数え・stream の照合・owner の期限は root が持ち、この層は要求を読み、答えを書き、
// 応答の完了か切断まで受け付けの枠を持つ。
const DETAIL_PATH = "/api/display/domains/U-F/detail";
const DETAIL_URL_BYTES = 1_024;
const DETAIL_MS = 2_000;
const DETAIL_STATUS = { ok: 200, invalidRequest: 400, versionChanged: 409, busy: 429, unavailable: 503, timeout: 504 } as const;

type DetailPort = (request: Readonly<{ streamId: string; detail: WeatherTimeseriesDetailRequest }>) =>
  Readonly<{ response: Promise<WeatherTimeseriesDetailResponse>; done: () => void }>;

// 欄は項目ごとに確かめて組み立てる。重複・欠け・形の違いは invalid。
function parseDetail(url: string): Readonly<{ streamId: string; detail: WeatherTimeseriesDetailRequest }> | null {
  if (Buffer.byteLength(url) > DETAIL_URL_BYTES) return null;
  let params: URLSearchParams;
  try { params = new URL(url, "http://localhost").searchParams; } catch { return null; }
  const one = (name: string): string | null => { const all = params.getAll(name); return all.length === 1 ? all[0] : null; };
  const streamId = one("streamId"), part = one("part"), revision = one("revision"), page = one("page"), id = one("id");
  if (streamId == null || !/^[\w-]{1,64}$/.test(streamId) || page == null || !/^\d{1,9}$/.test(page) || revision == null) return null;
  if (part === "index")
    return !params.has("id") && /^\d{1,16}$/.test(revision) ? { streamId, detail: { part, revision, page: Number(page) } } : null;
  if ((part === "current" || part === "lastKnown") && id != null && /^[0-9a-f]{64}$/.test(id) && /^\d{1,16}$/.test(revision))
    return { streamId, detail: { part, id, revision, page: Number(page) } };
  return null;
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}

function serveDetail(detail: DetailPort, request: Pick<IncomingMessage, "url">, response: ServerResponse): void {
  const admitted = performance.now();
  const parsed = parseDetail(request.url ?? "");
  if (parsed == null) return sendJson(response, 400, JSON.stringify({ kind: "error", reason: "invalidRequest", revision: null }));
  const { response: pending, done } = detail(parsed);
  let ended = false, answered = false;
  const end = () => { if (ended) return; ended = true; clearTimeout(timer); done(); };
  // 期限は受付（この関数の入口）から応答の終わりまで。読まなくなった client は 2 秒で切る。同じ瞬間に root が決めた答えを
  // 先に書くため、microtask を 1 回待つ。残り時間は受付の時刻から数え、root の同期処理の分を延ばさない。
  const timer = setTimeout(() => {
    void Promise.resolve().then(() => {
      // root の受付は関数入口より後なので、root の答えより先に期限が来うる。まだ何も書いていなければ 504 を書いてから、排出できなければ閉じる。
      if (!ended && !answered) { answered = true; sendJson(response, 504, JSON.stringify({ streamId: parsed.streamId, kind: "error", reason: "timeout", revision: null })); }
      if (!response.writableFinished) response.destroy();
      end();
    });
  }, Math.max(0, Math.ceil(DETAIL_MS - (performance.now() - admitted))));
  timer.unref();
  response.once("finish", end);
  response.once("close", end);
  void pending.then((result) => {
    if (ended || answered || response.destroyed) return;
    answered = true;
    // 書き出しの時点で期限を過ぎていれば、答えの中身にかかわらず timeout を書く。
    const answer: WeatherTimeseriesDetailResponse = performance.now() - admitted >= DETAIL_MS
      ? { kind: "error", reason: "timeout", revision: null } : result;
    sendJson(response, DETAIL_STATUS[answer.kind === "ok" ? "ok" : answer.reason], JSON.stringify({ streamId: parsed.streamId, ...answer }));
  });
}

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
  // AC14: P4 の認証がまだ無いので、表せる bind は loopback だけ。測定の起動経路が明示で渡す 1 つの IPv4 だけは例外（P3-PI-HARNESS-001）。
  host: "127.0.0.1" | "::1" | Readonly<{ measurementAddress: string }>;
  port: number;
  worker: DisplayWorkerView;
  onMarker?: (marker: TraceMarker, version: DisplayVersion) => void;
  // AC15 / R62: the single publish JSON.stringify span and its UTF-8 bytes, excluding client writes.
  onSerialize?: (observation: Readonly<{ version: DisplayVersion; bytes: number; durationMs: number }>) => void;
  // AC15: A9 HTML entry and flat ES module directory, served same-origin; absent keeps the 3 endpoints only.
  browserAssets?: Readonly<{ htmlPath: string; moduleDirectory: string }>;
  // P3-UFP-AC08: 無ければ詳細の経路は出さない（404）。
  detail?: DetailPort;
}>;

// The Node http owner of the latest snapshot and the ServerResponse objects (B11).
async function startDisplayServer(options: DisplayServerOptions) {
  if (typeof options.host === "string" ? options.host !== "127.0.0.1" && options.host !== "::1" : !isIPv4(options.host.measurementAddress) || options.host.measurementAddress === "0.0.0.0") throw new RangeError("display server binds loopback or one explicit measurement IPv4 only");
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

  const json = sendJson;

  const asset = (response: ServerResponse, file: string, contentType: string) => readFile(file, (error, body) => {
    // Missing names and directories (EISDIR) are both plain 404s.
    if (error != null) return json(response, 404, JSON.stringify({ reason: "notFound" }));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  });

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0];
    if (request.method !== "GET") return json(response, 405, JSON.stringify({ reason: "methodNotAllowed" }));
    const assets = options.browserAssets;
    if (assets != null && path === "/") return asset(response, assets.htmlPath, "text/html; charset=utf-8");
    const moduleName = assets == null || path == null ? null : MODULE_PATH.exec(path)?.[1];
    if (assets != null && moduleName != null)
      return asset(response, join(assets.moduleDirectory, `${moduleName}.js`), "text/javascript; charset=utf-8");
    if (path === "/healthz")
      return json(response, 200, JSON.stringify(handleHealth(worker, latest == null ? null : version(latest)).body));
    if (path === "/snapshot") {
      const result = handleSnapshot(latest);
      return json(response, result.status, result.status === 200 ? latestJson : JSON.stringify(result.body));
    }
    if (path === DETAIL_PATH && options.detail != null) return serveDetail(options.detail, request, response);
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
    server.listen(options.port, typeof options.host === "string" ? options.host : options.host.measurementAddress, () => {
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
      const serializeStart = performance.now();
      latestJson = JSON.stringify(snapshot);
      const serializeMs = performance.now() - serializeStart;
      for (const client of clients) deliver(client, { kind: "event", event: { event: "snapshot", id: String(snapshot.sequence), data: snapshot } });
      // Observed after delivery so a failing measurement observer cannot skip clients.
      options.onSerialize?.({ version: version(snapshot), bytes: Buffer.byteLength(latestJson), durationMs: serializeMs });
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

export { handleHealth, handleSnapshot, handleSse, serveDetail, startDisplayServer };
