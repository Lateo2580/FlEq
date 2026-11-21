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
import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types"; import type { WeatherCurrentDetailRequest, WeatherCurrentDetailResponse } from "../../contracts/p3-uw-canon.types"; import type { BulletinTextRequest, BulletinTextResponse } from "../../contracts/p3-bulletin-text-api.types"; import { validInputId } from "../contracts-revision/version";

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

type DetailPort = (request: Readonly<{ streamId: string; detail: WeatherTimeseriesDetailRequest | WeatherCurrentDetailRequest | BulletinTextRequest | WireDetailRequest }>) =>
  Readonly<{ response: Promise<WeatherTimeseriesDetailResponse | WeatherCurrentDetailResponse | BulletinTextResponse | WireDetailResponse>; done: () => void }>; // P4-DW-AC08: 新しい part

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
  const url = request.url ?? "", path = url.split("?")[0], unit = BULLETIN_TEXT_UNITS.get(path), parsed = unit != null ? parseBulletinText(url, unit) : (path === WEATHER_DETAIL_PATH ? parseWeatherDetail : parseDetail)(url); // P3-UWC-AC07 (4)・P3-BT-AC01
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
    const answer: WeatherTimeseriesDetailResponse | WeatherCurrentDetailResponse | BulletinTextResponse | WireDetailResponse = performance.now() - admitted >= DETAIL_MS
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
  detail?: DetailPort; wireAssets?: Readonly<{ htmlPath: string; moduleDirectory: string }>; // P4-DW-AC01: 新しい描画の骨組み（無ければ出さない）
}>;

// The Node http owner of the latest snapshot and the ServerResponse objects (B11).
async function startDisplayServer(options: DisplayServerOptions) {
  if (typeof options.host === "string" ? options.host !== "127.0.0.1" && options.host !== "::1" : !isIPv4(options.host.measurementAddress) || options.host.measurementAddress === "0.0.0.0") throw new RangeError("display server binds loopback or one explicit measurement IPv4 only");
  let latest: DisplaySnapshot | null = null;
  let latestJson = "";
  let worker = options.worker;
  const clients = new Set<Client>(); const wireClients = new Set<WireClient>(); let wireText: string | null = null, wireVersion: DisplayVersion | null = null; const wireBeat = setInterval(() => beatWire(wireClients, { worker, latestVersion: wireVersion, emittedAt: Date.now() }), HEARTBEAT_MS); wireBeat.unref(); // P4-DW-D-LEGACY=A: 新しい経路の client と最後の 1 通（直列化は公開ごとに 1 回）。heartbeat は旧の /events と同じ間隔（無受信の判定を同じに効かせる）

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
    const wire = options.wireAssets, wireModule = wire == null || path == null ? null : WIRE_MODULE_PATH.exec(path)?.[1]; if (wire != null && path === WIRE_HTML_PATH) return asset(response, wire.htmlPath, "text/html; charset=utf-8"); if (wire != null && wireModule != null) return asset(response, join(wire.moduleDirectory, `${wireModule}.js`), "text/javascript; charset=utf-8"); if (assets != null && path === "/") return asset(response, assets.htmlPath, "text/html; charset=utf-8"); // P4-DW-AC01: 新しい描画の path
    const moduleName = assets == null || path == null ? null : MODULE_PATH.exec(path)?.[1];
    if (assets != null && moduleName != null)
      return asset(response, join(assets.moduleDirectory, `${moduleName}.js`), "text/javascript; charset=utf-8");
    if (path === "/healthz")
      return json(response, 200, JSON.stringify(handleHealth(worker, latest == null ? null : version(latest)).body));
    if (path === "/snapshot") {
      const result = handleSnapshot(latest);
      return json(response, result.status, result.status === 200 ? latestJson : JSON.stringify(result.body));
    }
    if ((path === DETAIL_PATH || path === WEATHER_DETAIL_PATH || BULLETIN_TEXT_UNITS.has(path ?? "")) && options.detail != null) return serveDetail(options.detail, request, response);
    if (path === WIRE_EVENTS_PATH) return openWire(wireClients, response, wireText); if (path === WIRE_DETAIL_PATH && options.detail != null) return serveWireDetail(options.detail, request, response); if (path !== "/events") return json(response, 404, JSON.stringify({ reason: "notFound" })); // P4-DW-AC01: 新しい SSE の経路は /events の 404 の判定の前
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
      clearInterval(interval); clearInterval(wireBeat);
      for (const client of clients) client.response.destroy(); for (const client of wireClients) client.response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    // P4-DW-AC01: 新しい経路への公開。直列化は公開ごとに 1 回で、経路の全 client が共有する（P2-A8-COST の移行中の例外）。
    publishWire(snapshot: DisplayWireSnapshot) {
      wireText = `event: snapshot\nid: ${snapshot.sequence}\ndata: ${JSON.stringify(snapshot)}\n\n`;
      wireVersion = { streamId: snapshot.streamId, semanticRevision: snapshot.semanticRevision, sequence: snapshot.sequence };
      for (const client of wireClients) writeWire(client, wireText);
    },
    wireClientCount: () => wireClients.size,
  };
}

// P3-UWC-AC07 (4): U-W の詳細の経路。要求の上限・stream の照合・誤りの本文は U-F の口と同じで、part と id の形だけが違う
// （part=index か、part=areas|lastKnown と id）。欄は項目ごとに確かめて組み立て、重複・欠け・形の違いは invalid。
const WEATHER_DETAIL_PATH = "/api/display/domains/U-W/detail";
// P3-BT-AC01 (6): 要求の読み取りの先頭。U-W と U-V・U-N で共用する（U-F の parseDetail は他の契約が行を引くので別のまま）。
function detailQuery(url: string): Readonly<{ params: URLSearchParams; one: (name: string) => string | null }> | null {
  if (Buffer.byteLength(url) > DETAIL_URL_BYTES) return null;
  let params: URLSearchParams;
  try { params = new URL(url, "http://localhost").searchParams; } catch { return null; }
  return { params, one: (name) => { const all = params.getAll(name); return all.length === 1 ? all[0] : null; } };
}
function parseWeatherDetail(url: string): Readonly<{ streamId: string; detail: WeatherCurrentDetailRequest }> | null {
  const query = detailQuery(url);
  if (query == null) return null;
  const { params, one } = query;
  const streamId = one("streamId"), part = one("part"), revision = one("revision"), page = one("page"), id = one("id");
  if (streamId == null || !/^[\w-]{1,64}$/.test(streamId) || page == null || !/^\d{1,9}$/.test(page) || revision == null || !/^\d{1,16}$/.test(revision)) return null;
  if (part === "index")
    return params.has("id") ? null : { streamId, detail: { unit: "U-W", part, revision, page: Number(page) } };
  if ((part === "areas" || part === "lastKnown") && id != null && /^[0-9a-f]{64}$/.test(id))
    return { streamId, detail: { unit: "U-W", part, id, revision, page: Number(page) } };
  return null;
}

// P3-BT-AC01: 火山の解説と南海トラフの情報の本文の経路。答えと期限は serveDetail のまま。id は view の subject で、unit と family の組は owner の探索が決める。
const BULLETIN_TEXT_UNITS: ReadonlyMap<string, BulletinTextRequest["unit"]> = new Map([["/api/display/domains/U-V/detail", "U-V"], ["/api/display/domains/U-N/detail", "U-N"]]);
const BULLETIN_SUBJECT = /^(?:normal|training|test)\/(?:VFVO51|VFVO60|VZVO40|VYSE50|VYSE51|VYSE52|VYSE60)\/[\x21\x23-\x2e\x30-\x5b\x5d-\x7e]{1,64}$/;
// revision は view の source の inputId・reportDateTimeRaw・controlDateTimeRaw の JSON 配列（P3-BT-D-KEY）。一致は owner が見るので、ここは形だけ確かめる。
function bulletinRevision(raw: string): boolean {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [inputId, report, control]: readonly unknown[] = value;
  return typeof inputId === "string" && validInputId(inputId) && typeof report === "string" && report.length <= 40 && typeof control === "string" && control.length <= 40;
}
function parseBulletinText(url: string, unit: BulletinTextRequest["unit"]): Readonly<{ streamId: string; detail: BulletinTextRequest }> | null {
  const query = detailQuery(url);
  if (query == null) return null;
  const streamId = query.one("streamId"), part = query.one("part"), id = query.one("id"), revision = query.one("revision");
  if (streamId == null || !/^[\w-]{1,64}$/.test(streamId) || part !== "text" || id == null || !BULLETIN_SUBJECT.test(id) || revision == null || !bulletinRevision(revision)) return null;
  return { streamId, detail: { unit, part, id, revision } };
}

export { handleHealth, handleSnapshot, handleSse, serveDetail, startDisplayServer };

// ---- P4-DISPLAY-WIRE-001（B0）: 新しい経路（P4-DW-D-LEGACY=A）。import は行を足さない書き方のため file の最後に置く（宣言は巻き上がる） ----
import type { DisplayWireSnapshot, WireDetailRequest, WireDetailResponse } from "../../contracts/p4-display-wire.types";

const WIRE_EVENTS_PATH = "/api/display/wire/events";
const WIRE_HTML_PATH = "/display";
// 名前の白い表が path の確かめ（/chrome-eew/ と同じ形、AC15）。
const WIRE_MODULE_PATH = /^\/display\/([a-z0-9-]+)\.js$/;
// 1 client に待ちの 1 通（P2-SNAPSHOT-SSE-001 の AC03 と同じ規則）。旧の handleSse は旧の snapshot の型に結び付いているので、同じ規則を字の 1 通で持つ。
type WireClient = { response: ServerResponse; waiting: string | null; blocked: boolean; timer: NodeJS.Timeout | null };
function writeWire(client: WireClient, text: string): void {
  if (client.blocked) { client.waiting = text; return; }
  if (client.response.write(text)) return;
  // 書けなかった最初の時から 5 秒で切る。待ちの間の新しい 1 通は待ちを置き換えるだけで、期限を延ばさない。
  client.blocked = true;
  client.timer = setTimeout(() => client.response.destroy(), SLOW_CLIENT_MS);
  client.timer.unref();
}
// heartbeat は書けない間は落とす（旧の handleSse と同じ）。中身は旧と同じ形（worker・最後の版・送った時刻）。
function beatWire(clients: ReadonlySet<WireClient>, data: Readonly<{ worker: DisplayWorkerView; latestVersion: DisplayVersion | null; emittedAt: number }>): void {
  const text = `event: heartbeat\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) if (!client.blocked) writeWire(client, text);
}
function openWire(clients: Set<WireClient>, response: ServerResponse, latest: string | null): void {
  if (clients.size >= CLIENT_LIMIT) return sendJson(response, 503, JSON.stringify({ reason: "clientLimit" }));
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  response.flushHeaders();
  const client: WireClient = { response, waiting: null, blocked: false, timer: null };
  clients.add(client);
  response.on("drain", () => {
    if (client.timer != null) clearTimeout(client.timer);
    const waiting = client.waiting;
    Object.assign(client, { blocked: false, waiting: null, timer: null });
    if (waiting != null) writeWire(client, waiting);
  });
  response.on("close", () => {
    if (client.timer != null) clearTimeout(client.timer);
    clients.delete(client);
  });
  if (latest != null) writeWire(client, latest);
}

// P4-DW-AC08: 新しい part の詳細の経路（1 本の path で unit と part を欄で受ける）。欄は項目ごとに確かめて組み立て、重複・欠け・形の違いは invalid。
const WIRE_DETAIL_PATH = "/api/display/wire/detail", WIRE_DETAIL_BYTES = 65_536;
const INDEX_UNITS = ["U-T", "U-Q", "U-N", "U-V", "U-M", "U-L", "U-R", "U-B", "U-Y"] as const;
const CARD_UNITS = ["U-E", "U-W", "U-F", "U-T", "U-Q", "U-N", "U-V", "U-L", "U-R", "U-B", "U-M", "U-Y"] as const;
function parseWireDetail(url: string): Readonly<{ streamId: string; detail: WireDetailRequest }> | null {
  const query = detailQuery(url);
  if (query == null) return null;
  const { params, one } = query;
  const streamId = one("streamId"), unit = one("unit"), part = one("part"), id = one("id"), revision = one("revision"), pageText = one("page");
  if (streamId == null || !/^[\w-]{1,64}$/.test(streamId) || revision == null) return null;
  const page = pageText != null && /^\d{1,9}$/.test(pageText) ? Number(pageText) : null;
  const hex = (value: string | null): value is string => value != null && /^[0-9a-f]{64}$/.test(value);
  const index = INDEX_UNITS.find((item) => item === unit), card = CARD_UNITS.find((item) => item === unit);
  if (part === "index") return index != null && page != null && !params.has("id") && /^\d{1,16}$/.test(revision) ? { streamId, detail: { unit: index, part, revision, page } } : null;
  if (part === "raw") return card != null && id != null && validInputId(id) && /^-?\d{1,16}$/.test(revision) && !params.has("page") ? { streamId, detail: { unit: card, part, id, revision } } : null;
  if (!hex(id) || !hex(revision)) return null;
  if (part === "comment") return unit === "U-T" && !params.has("page") ? { streamId, detail: { unit, part, id, revision } } : null;
  if (page == null) return null;
  if (part === "areas" && (unit === "U-E" || unit === "U-T")) return unit === "U-E" ? { streamId, detail: { unit, part, id, revision, page } } : { streamId, detail: { unit, part, id, revision, page } };
  if (part === "stations" && unit === "U-T") return { streamId, detail: { unit, part, id, revision, page } };
  if (part === "event" && unit === "U-Q") return { streamId, detail: { unit, part, id, revision, page } };
  return null;
}
// 答えと期限は serveDetail と同じ規則（受付から 2 秒、root の答えを先に書くため microtask を 1 回待つ）。serveDetail は配送済みの part の読み取りを
// 中に持ち、行を足さない書き方では差し替えられないので、同じ手順をここに持つ。
function serveWireDetail(detail: DetailPort, request: Pick<IncomingMessage, "url">, response: ServerResponse): void {
  const admitted = performance.now();
  const parsed = parseWireDetail(request.url ?? "");
  if (parsed == null) return sendJson(response, 400, JSON.stringify({ kind: "error", reason: "invalidRequest", revision: null }));
  const { response: pending, done } = detail(parsed);
  let closed = false, answered = false;
  const finish = () => { if (closed) return; closed = true; clearTimeout(timer); done(); };
  const timer = setTimeout(() => {
    void Promise.resolve().then(() => {
      if (!closed && !answered) { answered = true; sendJson(response, 504, JSON.stringify({ streamId: parsed.streamId, kind: "error", reason: "timeout", revision: null })); }
      if (response.writableFinished !== true) response.destroy();
      finish();
    });
  }, Math.max(0, Math.ceil(DETAIL_MS - (performance.now() - admitted))));
  timer.unref(); // 期限の timer は process を止めない
  response.once("finish", finish);
  response.once("close", finish);
  void pending.then((result) => {
    if (closed || answered || response.destroyed) return;
    answered = true;
    const answer = performance.now() - admitted >= DETAIL_MS ? { kind: "error" as const, reason: "timeout" as const, revision: null } : result;
    // 返す直前に本文の全体を確かめる（直列化はこの 1 回だけ）。越えたら 200 にせず 503 と reason を返す（P4-DW-RES-02）。
    const text = JSON.stringify({ streamId: parsed.streamId, ...answer });
    if (Buffer.byteLength(text) > WIRE_DETAIL_BYTES) return sendJson(response, 503, JSON.stringify({ streamId: parsed.streamId, kind: "error", reason: "responseTooLarge", revision: null }));
    sendJson(response, DETAIL_STATUS[answer.kind === "ok" ? "ok" : answer.reason], text);
  });
}
