import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, DiagnosticLevel, DiagnosticReason, MailboxEnvelope, ShutdownSummary } from "../../contracts/p2-shared-runtime.types";
import type { DmdataClassification, DmdataSubscription } from "../../contracts/p3-dmdata-connect.types";
import { startDisplayServer } from "../http-sse/http-sse";
import { ingestXmlData } from "../ingress/ingress";
import type { ParsedFrame } from "../ingress/ingress";
import { resolveRepoPath } from "../notification-delivery/adapter";
import type { ExecutionPlace, OwnerReply, OwnerStartData } from "../../contracts/p3-execution-split.types";
import { RuntimeCompositionRoot, linkedUnitCodecs } from "../runtime/composition-root";
import { completeDiagnostic } from "../runtime/runtime-diagnostic";
import { closeSocket, listSockets, startSocket } from "./dmdata-rest";

// P2-A10-AC12 (R63): provisional fixed interval for a normal disconnect or handshake failure. No backoff, no setting.
const RECONNECT_MS = 5_000;
// P3-C2-RES-06 (provisional): a REST-stage or capacity failure waits longer so a dead key or a dmdata outage is not polled every 5 s.
const REST_RETRY_MS = 60_000;
// P3-C2-RES-04 / DLV-02 (provisional; legacy ws-client.ts:54): handshake limit, and the current WS is cut 90 s after its last frame.
const HANDSHAKE_MS = 15_000;
const LIVENESS_MS = 90_000;
// spec:2113: open and waiting dmdata sockets of every appName, the one to start included.
const SOCKET_LIMIT = 4;
// P3-C2-RES-07 (spec:889): the stop request through the connection cleanup, inside the overall shutdown limit.
const STOP_LIMIT_MS = 30_000;
const TICK_MS = 1_000;
// dmdata control frames (start/ping/pong/error) are small: a small frame is decoded and parsed once here and the
// result goes on to ingress. Larger frames go straight to ingress, which parses them once (P3-C3A-RES-04).
const CONTROL_PEEK_BYTES = 16 * 1024;
const knownClassifications: Readonly<Record<DmdataClassification, true>> = {
  "telegram.earthquake": true, "eew.forecast": true, "eew.warning": true, "telegram.volcano": true, "telegram.weather": true,
};

// P3-C2-ENTRY: one start function; only how the connection is obtained differs, frames take the same path.
type P2HostConfig = Readonly<({ wsUrl: string; dmdata?: never } | { dmdata: DmdataSubscription; wsUrl?: never }) & {
  stateDirectory: string;
  diagnosticDirectory: string;
  displayPort: number;
  clock: () => ClockReading;
  observe: ((observation: P2HostObservation) => void) | null;
}>;

// How one connection attempt ended; the retry interval follows from it (P3-C2-RETRY).
type Attempt = "opened" | "retrySoon" | "retryLater" | "authRejected" | "stopped";
type ControlHead = { type?: unknown; pingId?: unknown; socketId?: unknown; classifications?: unknown; close?: unknown };

function toBuffer(raw: RawData): Buffer {
  return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
}

// P3-C3A-AC04: the one fatal UTF-8 decode and JSON.parse of a small frame, as ingress would do it; the result goes
// on to ingress, which then does not parse again (invalid UTF-8 or JSON is rejected there as envelopeInvalid).
function parseFrame(bytes: Uint8Array): ParsedFrame {
  const start = performance.now();
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { kind: "parsed", value, jsonMs: performance.now() - start };
  } catch { return { kind: "failed" }; }
}

// Only a parsed object can be a control frame; anything else goes the data path.
function controlHead(value: unknown): ControlHead | null {
  return value != null && typeof value === "object" ? value : null;
}

const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The one P2 product host: WS frames in, mailbox, decode, runtime, display out. */
async function startP2Host(config: P2HostConfig): Promise<Readonly<{ displayPort: number; stop(): Promise<ShutdownSummary> }>> {
  const { clock } = config;
  // P3-C2-AC01: checked before anything starts; the appName is validateAppConfig's (empty and "fleq" are refused there).
  if (config.dmdata != null) {
    const { apiKey, classifications } = config.dmdata;
    if (apiKey.trim() === "" || classifications.length === 0 || new Set(classifications).size !== classifications.length
      || !classifications.every((item) => Object.hasOwn(knownClassifications, item)))
      throw new Error("invalid dmdata subscription");
  }
  const runId = randomUUID();
  // A measurement observer must not change the product path.
  const emit = (observation: P2HostObservation) => {
    if (config.observe == null) return;
    try { config.observe(observation); } catch { /* observer failure is the runner's to detect */ }
  };

  const server = await startDisplayServer({
    host: "127.0.0.1", port: config.displayPort,
    worker: { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null },
    browserAssets: { htmlPath: resolveRepoPath("reconstruction/src/display/chrome-eew/index.html"),
      moduleDirectory: resolveRepoPath("reconstruction/dist/chrome-eew/src/display/chrome-eew") },
    onMarker: (marker, displayVersion) => emit({ kind: "marker", point: "T4", runId, displayVersion, monotonicMs: marker.monotonicMs }),
    onSerialize: ({ version, bytes, durationMs }) => emit({ kind: "publishSerialization", displayVersion: version, bytes, durationMs }),
  });

  // P3-C3A-AC01: three resident owner threads (dist worker entry), created once here, never per input or request.
  const workers = new Map<ExecutionPlace, Worker>();
  let root: RuntimeCompositionRoot;
  // From the worker close stage (and on a failed start) an owner's exit is expected and is not a failure (P3-C3B).
  let ownersStopping = false;
  const endOwners = async () => {
    ownersStopping = true;
    await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  };
  // P3-C3B-OWNER-STOP (A): an owner's error, or an exit before endOwners, stops that owner only; the process goes on.
  // Before the runtime has started, the recorded stop rejects startRuntime (and so startP2Host) instead.
  // root is unassigned only if its constructor threw; the catch below then ends the owners.
  const ownerFailed = (place: ExecutionPlace, cause: unknown) => { if (root != null) root.ownerFailed(place, cause); };
  try {
    const entry = resolveRepoPath("reconstruction/dist/src/runtime/owner-worker.js");
    for (const place of ["urgent", "weatherCurrent", "deferred"] as const) {
      const start: OwnerStartData = { place, stateDirectory: config.stateDirectory, publisherTimeOriginMs: performance.timeOrigin };
      const worker = new Worker(entry, { workerData: start });
      workers.set(place, worker);
      worker.on("message", (reply: OwnerReply) => {
        // AC13: T2 and decode are the owner's times, so they are observed before the reply is projected (T3).
        if (reply.kind === "inputDone") {
          const { inputId } = reply.settlement;
          emit({ kind: "marker", point: "T2", runId, inputId, monotonicMs: reply.processingStartedMs });
          if (reply.decode != null) emit({ kind: "decode", runId, inputId, ...reply.decode });
        }
        root.receive(place, reply);
      });
      worker.on("error", (error) => ownerFailed(place, error));
      worker.on("exit", (code) => { if (!ownersStopping) ownerFailed(place, new Error(`owner thread exited (code ${code})`)); });
    }
    root = new RuntimeCompositionRoot({ appName: config.dmdata?.appName ?? "fleq-p2", legacyAppName: "fleq", stateDirectory: config.stateDirectory,
      legacyStateDirectory: `${resolve(config.stateDirectory)}.legacy`, diagnosticDirectory: config.diagnosticDirectory },
    linkedUnitCodecs, {
      send: (place, request) => workers.get(place)!.postMessage(request), clock,
      display: { publish: server.publish, setWorker: server.setWorker,
        onMarker: (marker, displayVersion) => emit({ kind: "marker", point: "T3", runId, displayVersion, monotonicMs: marker.monotonicMs }) },
      onMeasurements: (measurements) => { for (const measurement of measurements) emit({ kind: "checkpoint", measurement }); },
      onInputDone: (reply) => {
        const { inputId } = reply.settlement;
        if (config.observe != null) {
          // A decoded input has its parse marks; a parser rejection has none (no processing record, as before).
          const { workerTransferMs: _transfer, ingressJsonMs: _json, ...parsed } = reply.marks;
          if (Object.values(parsed).some((value) => value != null)) emit({ kind: "processing", measurement: { runId, inputId,
            startedMonotonicMs: reply.processingStartedMs, endedMonotonicMs: performance.now(),
            marks: { ...reply.marks, ingressJsonMs: ingressJsonMs.get(inputId) ?? null } } });
          ingressJsonMs.delete(inputId);
        }
        resumeIfDrained();
      },
      shutdownHooks: { drainMailbox: async (_deadline, active) => root.drainInputs(active), closeWorker: endOwners },
    });
    await root.startRuntime(runId, clock(), { desktop: { kind: "idle" }, sound: { kind: "idle" } });
  } catch (error) {
    // Every owner created so far ends before the rejection (P3-C3A-AC01).
    await endOwners();
    await server.close();
    throw error;
  }
  const mailbox = root.mailbox;

  let stopping: Promise<ShutdownSummary> | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  // The attempt in flight (or the last one); stop() lets it settle before releasing the own dmdata socket.
  let attempt: Promise<Attempt> | null = null;
  // The id a successful POST returned to this process, until a DELETE succeeds or a list no longer has it (RES-02).
  let ownSocketId: number | null = null;
  // Aborted at the stop request + 30 s: every dmdata REST still in flight is destroyed and none starts (RES-07).
  const halt = new AbortController();
  // Monotonic time of the current WS's open or last frame (P3-C2-LIVENESS).
  let lastFrameAt = 0;
  let overloaded = false;
  let lastSequence = 0;
  let lastAccepted: Readonly<{ sequence: number; inputId: string }> | null = null;
  // Only kept while observing: ingress's JSON time is one of the seven P1 durations of the processing record.
  const ingressJsonMs = new Map<string, number | null>();

  const recordRejected = (diagnostic: ParserDiagnostic, wallTimeMs: number) =>
    root.enqueueDiagnostic(root.projectParserDiagnostic(diagnostic, runId, wallTimeMs).event);
  // WARN and ERROR carry no count or durationMs: the sink counts repeats in count (AC05).
  const note = (level: DiagnosticLevel, reason: DiagnosticReason, count?: number) =>
    root.enqueueDiagnostic(completeDiagnostic({ level, component: "host", reason, ...(count == null ? {} : { count }) }, clock(), runId));

  const dispatchLost = () => {
    if (root.state.shutdown.stage !== "running") return;
    root.dispatch({ kind: "connectionLost", acceptedThroughSequence: lastAccepted?.sequence ?? -1, clock: clock() });
  };

  // The one place an attempt starts: an unexpected rejection counts as a WS failure, so stop() and the retry still run.
  function startAttempt(): Promise<Attempt> {
    attempt = connect().catch((): Attempt => "retrySoon");
    return attempt;
  }

  function startConnect(): void {
    void startAttempt().then(retryAfter);
  }

  function retryAfter(result: Attempt): void {
    if (result === "retrySoon") scheduleReconnect(RECONNECT_MS);
    else if (result === "retryLater") scheduleReconnect(REST_RETRY_MS);
  }

  function scheduleReconnect(delayMs: number): void {
    if (stopping != null || reconnectTimer != null) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startConnect(); }, delayMs);
  }

  // Overload reconnects only after the parser input waiting in the mailbox is gone; a normal disconnect uses the timer.
  function resumeIfDrained(): void {
    if (!overloaded || stopping != null) return;
    const stats = mailbox.stats(clock().monotonicMs);
    if (stats.pendingItems !== 0 || stats.inFlightItems !== 0) return;
    overloaded = false;
    startConnect();
  }

  function overload(reason: "itemLimit" | "byteLimit", ws: WebSocket, wallTimeMs: number): void {
    overloaded = true;
    // The loss starts after the last accepted input; the event timestamp is the loss start wall clock.
    root.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "host",
      reason: reason === "itemLimit" ? "mailboxRejectedItemLimit" : "mailboxRejectedByteLimit",
      ...(lastAccepted == null ? {} : { inputId: lastAccepted.inputId }), count: lastAccepted?.sequence ?? -1 },
    { wallTimeMs, monotonicMs: clock().monotonicMs }, runId));
    dispatchLost();
    socket = null;
    ws.terminate();
    resumeIfDrained();
  }

  // P3-C2-AC05/AC06: a well-formed start is recorded and ends reconnecting; a malformed one is an unknown control frame.
  function acceptStart(head: ControlHead, t0: number): boolean {
    const { socketId, classifications } = head;
    if (typeof socketId !== "number" || !Number.isInteger(socketId) || !isStrings(classifications)) return false;
    note("INFO", "dmdataSocketStarted", socketId);
    if (config.dmdata?.classifications.some((item) => !classifications.includes(item))) note("WARN", "dmdataSubscriptionNarrowed");
    root.recordConnected();
    emit({ kind: "controlFrame", frameType: "start", monotonicMs: t0, errorClose: null });
    return true;
  }

  function onFrame(ws: WebSocket, raw: RawData): void {
    const t0 = performance.now();
    if (overloaded || stopping != null) return;
    const bytes = toBuffer(raw);
    const entry = clock();
    lastFrameAt = entry.monotonicMs;
    const parsed = bytes.byteLength <= CONTROL_PEEK_BYTES ? parseFrame(bytes) : undefined;
    if (parsed != null) {
      const head = parsed.kind === "parsed" ? controlHead(parsed.value) : null;
      if (head?.type === "ping") {
        emit({ kind: "controlFrame", frameType: "ping", monotonicMs: t0, errorClose: null });
        if (typeof head.pingId === "string") ws.send(JSON.stringify({ type: "pong", pingId: head.pingId }), () => {});
        return;
      }
      if (head?.type === "start" && acceptStart(head, t0)) return;
      if (head?.type === "pong") return;
      if (head?.type === "error") {
        note("WARN", "dmdataErrorFrame");
        emit({ kind: "controlFrame", frameType: "error", monotonicMs: t0, errorClose: typeof head.close === "boolean" ? head.close : null });
        ws.terminate();
        return;
      }
      if (typeof head?.type === "string" && head.type !== "data") {
        recordRejected({ inputId: "unknown-control", reason: "envelopeInvalid", operation: { kind: "undetermined", sources: {} },
          encodedByteLength: bytes.byteLength, expandedByteLength: null }, entry.wallTimeMs);
        return;
      }
    }
    // Everything else may be data: it is an input whether or not ingress or the mailbox accept it.
    root.recordInput(entry.wallTimeMs);
    lastSequence += 1;
    const inputId = `input-${lastSequence}`;
    emit({ kind: "marker", point: "T0", runId, inputId, monotonicMs: t0 });
    const ingressed = ingestXmlData({ inputId, inputSequence: lastSequence, receivedAt: entry.wallTimeMs,
      origin: "live", kind: "ws", frame: bytes, parsed });
    if (ingressed.kind === "rejected") { recordRejected(ingressed.diagnostic, entry.wallTimeMs); return; }
    const { item } = ingressed;
    // The priority reason is the validated outer shape only; meaning stays with parser and units.
    const envelope: MailboxEnvelope = { messageId: inputId, runId, t0MonotonicMs: entry.monotonicMs,
      enqueuedMonotonicMs: clock().monotonicMs, payload: { kind: "parser", item },
      priorityReason: item.headType === "VXSE43" || item.headType === "VXSE45" ? "eewCandidate" : "normal" };
    // P3-C3B-AC02: an input for a stopped or unresponsive owner is refused here; the other places go on receiving.
    if (root.refuseInput(inputId, item.headType, entry)) return;
    const t1 = performance.now();
    const result = mailbox.enqueue(envelope);
    if (result.kind === "rejected") {
      if (result.reason !== "draining") overload(result.reason, ws, entry.wallTimeMs);
      return;
    }
    lastAccepted = { sequence: lastSequence, inputId };
    if (config.observe != null) ingressJsonMs.set(inputId, ingressed.ingressJsonMs);
    emit({ kind: "marker", point: "T1", runId, inputId, monotonicMs: t1 });
    if (stopping == null) root.pump();
  }

  // spec §10.1 / P3-C2-AC02: list, release the own previous socket, check capacity, start. A failure leaves the WS closed.
  // Every await is followed by the stop check so a stopping host never opens a WS.
  async function startDmdataSocket(dmdata: DmdataSubscription): Promise<Readonly<{ url: string; protocol: readonly string[] }> | Attempt> {
    const refused = (kind: "failed" | "authRejected" | "uncertain", reason: DiagnosticReason): Attempt => {
      if (kind === "authRejected") { note("ERROR", "dmdataAuthRejected"); return "authRejected"; }
      note("WARN", kind === "uncertain" ? "dmdataSocketStartUncertain" : reason);
      return "retryLater";
    };
    const [open, waiting] = await Promise.all([listSockets(dmdata.apiKey, "open", halt.signal),
      listSockets(dmdata.apiKey, "waiting", halt.signal)]);
    if (stopping != null) return "stopped";
    if (open.kind !== "ok" || waiting.kind !== "ok")
      return refused(open.kind === "authRejected" || waiting.kind === "authRejected" ? "authRejected" : "failed", "dmdataSocketListFailed");
    const listed = [...open.sockets, ...waiting.sockets];
    let released: number | null = null;
    // Only the id this process got back is ever closed; every other socket is counted, never closed (P3-C2-OWNERSHIP).
    if (ownSocketId != null && listed.some((item) => item.id === ownSocketId)) {
      const closed = await closeSocket(dmdata.apiKey, ownSocketId, halt.signal);
      // Forgotten before the stop check, so stop() does not DELETE the same id again.
      if (closed.kind === "ok") { released = ownSocketId; ownSocketId = null; }
      if (stopping != null) return "stopped";
      if (closed.kind !== "ok") return refused(closed.kind, "dmdataSocketCloseFailed");
    }
    ownSocketId = null;
    if (listed.filter((item) => item.id !== released).length + 1 > SOCKET_LIMIT) return refused("failed", "dmdataConnectionCapacityExceeded");
    const started = await startSocket(dmdata, halt.signal);
    if (started.kind === "ok") ownSocketId = started.id;
    if (stopping != null) return "stopped";
    if (started.kind !== "ok") return refused(started.kind, "dmdataSocketStartFailed");
    return { url: started.url, protocol: started.protocol };
  }

  async function connect(): Promise<Attempt> {
    let url: string;
    let protocols: readonly string[] = [];
    if (config.dmdata == null) url = config.wsUrl;
    else {
      const target = await startDmdataSocket(config.dmdata);
      if (typeof target === "string") return target;
      // stop() may have begun in the turn between that check and this one.
      if (stopping != null) return "stopped";
      ({ url, protocol: protocols } = target);
    }
    return new Promise<Attempt>((settle) => {
      let ws: WebSocket;
      // The URL may carry a credential: nothing here keeps it.
      try { ws = new WebSocket(url, [...protocols], { handshakeTimeout: HANDSHAKE_MS }); } catch { settle("retrySoon"); return; }
      let opened = false;
      socket = ws;
      ws.on("open", () => { opened = true; lastFrameAt = clock().monotonicMs; settle("opened"); });
      ws.on("message", (raw) => { if (socket === ws) onFrame(ws, raw); });
      ws.on("error", () => { /* close follows */ });
      ws.on("close", () => {
        if (!opened) { if (socket === ws) socket = null; settle(stopping != null ? "stopped" : "retrySoon"); return; }
        if (socket !== ws) return;
        socket = null;
        if (stopping != null) return;
        dispatchLost();
        scheduleReconnect(RECONNECT_MS);
      });
    });
  }

  function tick(): void {
    if (stopping != null) return;
    const now = clock();
    // P3-C2-LIVENESS: one comparison per tick cuts a half-open TCP; the close path reports the loss and reconnects.
    const current = socket;
    if (current?.readyState === WebSocket.OPEN && now.monotonicMs - lastFrameAt >= LIVENESS_MS) {
      note("WARN", "connectionLivenessExpired");
      current.terminate();
    }
    root.tick(now);
    // P3-C3B-AC01: the owners' own answers decide the worker state, not the tick.
    if (root.setWorker(root.monitorOwners(now))) server.heartbeat();
    // Every tick, a write right out included: its 3 s / 10 s monitor must run while an owner holds it (P3-C3B-AC02).
    // A broken invariant takes the process down (I/O failures come back as failed/uncertain results); ignored while stopping.
    void root.driveCheckpoint().catch((error) => { if (stopping == null) throw error; });
  }
  const tickTimer = setInterval(tick, TICK_MS);

  // P3-C2-RES-07: let the attempt in flight settle, then DELETE the own socket once. At the stop request + 30 s the
  // REST still in flight is destroyed (halt) and the wait ends.
  async function releaseOwnSocket(deadlineMonotonicMs: number): Promise<void> {
    const dmdata = config.dmdata;
    if (dmdata == null) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((done) => {
      timer = setTimeout(() => { halt.abort(); done("expired"); }, deadlineMonotonicMs - clock().monotonicMs);
    });
    const released = (async () => {
      await attempt;
      if (ownSocketId == null) return "ok";
      // No DELETE starts at or after the limit, even before its timer has run: that socket stays (residual risk).
      if (halt.signal.aborted || clock().monotonicMs >= deadlineMonotonicMs) return "expired";
      const closed = await closeSocket(dmdata.apiKey, ownSocketId, halt.signal);
      if (closed.kind === "ok") ownSocketId = null;
      return closed.kind;
    })();
    const outcome = await Promise.race([released, expired]);
    clearTimeout(timer);
    if (outcome === "ok") return;
    const recorded = note("WARN", "dmdataSocketCloseFailed");
    if (recorded.kind === "dropped" && recorded.reason === "sinkUnavailable") process.stderr.write("fleq host: dmdata socket close failed\n");
  }

  const stop = (): Promise<ShutdownSummary> => stopping ??= (async () => {
    // The stop request is the origin of the overall shutdown limit; the cleanup runs beside shutdownRuntime, not before it.
    const requested = clock();
    clearInterval(tickTimer);
    if (reconnectTimer != null) clearTimeout(reconnectTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const ws = socket;
    socket = null;
    ws?.terminate();
    const cleanup = releaseOwnSocket(requested.monotonicMs + STOP_LIMIT_MS);
    try { return await root.shutdownRuntime(lastAccepted?.sequence ?? 0, requested); }
    finally {
      await cleanup;
      await endOwners();
      await server.close();
    }
  })();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // P2-A1-PROBE: startup publishes the checking snapshot; the probe result arrives asynchronously.
  void root.probeNotificationChannels().then((channels) => {
    if (stopping == null) root.dispatch({ kind: "notificationProbeCompleted", channels, clock: clock() });
  });

  const first = await startAttempt();
  // { wsUrl } rejects on any initial failure (P2-A10-AC12); { dmdata } only where retrying cannot help (P3-C2-RETRY).
  if (first === "authRejected" || (config.dmdata == null && first !== "opened")) {
    await stop().catch(() => {});
    throw new Error(first === "authRejected" ? "dmdata authentication rejected" : "WebSocket connection failed");
  }
  if (first !== "opened") {
    dispatchLost();
    retryAfter(first);
  }
  return { displayPort: server.port, stop };
}

export { startP2Host };
export type { P2HostConfig };
