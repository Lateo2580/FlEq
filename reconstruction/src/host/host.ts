import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import type { P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type { ClockReading, MailboxEnvelope, ShutdownSummary } from "../../contracts/p2-shared-runtime.types";
import { decodeMaterial } from "../decode-material/decode-material";
import { startDisplayServer } from "../http-sse/http-sse";
import { ingestXmlData } from "../ingress/ingress";
import { resolveRepoPath } from "../notification-delivery/adapter";
import { RuntimeCompositionRoot, linkedUnitCodecs } from "../runtime/composition-root";
import { completeDiagnostic } from "../runtime/runtime-diagnostic";

// P2-A10-AC12 (R63): provisional fixed interval for a normal disconnect. No backoff, no setting.
const RECONNECT_MS = 5_000;
const TICK_MS = 1_000;
// dmdata control frames (start/ping/pong/error) are small. Larger frames go straight to ingress so a data frame
// (up to 8 MiB) is JSON-parsed once, by ingress.
const CONTROL_PEEK_BYTES = 16 * 1024;

type P2HostConfig = Readonly<{
  wsUrl: string;
  stateDirectory: string;
  diagnosticDirectory: string;
  displayPort: number;
  clock: () => ClockReading;
  observe: ((observation: P2HostObservation) => void) | null;
}>;

function toBuffer(raw: RawData): Buffer {
  return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
}

function peekHead(bytes: Buffer): { type?: unknown; pingId?: unknown } | null {
  try {
    const message: unknown = JSON.parse(bytes.toString("utf8"));
    return message != null && typeof message === "object" ? message : null;
  } catch { return null; }
}

/** The one P2 product host: WS frames in, mailbox, decode, runtime, display out. */
async function startP2Host(config: P2HostConfig): Promise<Readonly<{ displayPort: number; stop(): Promise<ShutdownSummary> }>> {
  const { clock } = config;
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

  let root: RuntimeCompositionRoot;
  try {
    root = new RuntimeCompositionRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: config.stateDirectory,
      legacyStateDirectory: `${resolve(config.stateDirectory)}.legacy`, diagnosticDirectory: config.diagnosticDirectory },
    linkedUnitCodecs, {
      clock,
      display: { publish: server.publish, setWorker: server.setWorker,
        onMarker: (marker, displayVersion) => emit({ kind: "marker", point: "T3", runId, displayVersion, monotonicMs: marker.monotonicMs }) },
      onMeasurements: (measurements) => { for (const measurement of measurements) emit({ kind: "checkpoint", measurement }); },
      shutdownHooks: { drainMailbox: async (_deadline, active) => { while (active() && processOne()) { /* drain */ } } },
    });
    root.startRuntime(runId, clock(), { desktop: { kind: "idle" }, sound: { kind: "idle" } });
  } catch (error) {
    await server.close();
    throw error;
  }
  const mailbox = root.mailbox;

  let stopping: Promise<ShutdownSummary> | null = null;
  let socket: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let overloaded = false;
  let pumpScheduled = false;
  let saving = false;
  let lastSequence = 0;
  let lastAccepted: Readonly<{ sequence: number; inputId: string }> | null = null;
  // Only kept while observing: ingress's JSON time is one of the seven P1 durations of the processing record.
  const ingressJsonMs = new Map<string, number | null>();

  const recordRejected = (diagnostic: ParserDiagnostic, wallTimeMs: number) =>
    root.enqueueDiagnostic(root.projectParserDiagnostic(diagnostic, runId, wallTimeMs).event);

  const dispatchLost = () => {
    if (root.state.shutdown.stage !== "running") return;
    root.dispatch(root.state, { kind: "connectionLost", acceptedThroughSequence: lastAccepted?.sequence ?? -1, clock: clock() });
  };

  function processOne(): boolean {
    const takenAt = clock().monotonicMs;
    const envelope = mailbox.takeNext(takenAt);
    if (envelope == null) return false;
    const t2 = performance.now();
    if (envelope.payload.kind !== "parser") throw new Error("host mailbox holds parser items only");
    const { item } = envelope.payload;
    emit({ kind: "marker", point: "T2", runId, inputId: item.inputId, monotonicMs: t2 });
    const decodeStarted = performance.now();
    const result = decodeMaterial(item);
    const decodeEnded = performance.now();
    emit({ kind: "decode", runId, inputId: item.inputId, startedMonotonicMs: decodeStarted, endedMonotonicMs: decodeEnded });
    const done = clock();
    const completion = { kind: "parser", messageId: envelope.messageId, runId: envelope.runId,
      encodedByteLength: item.encodedByteLength, startedMonotonicMs: takenAt, completedMonotonicMs: done.monotonicMs,
      inputId: item.inputId, inputSequence: item.inputSequence, result } as const;
    mailbox.complete(completion);
    root.dispatch(root.state, { kind: "mailboxCompleted", completion, clock: done });
    if (config.observe != null) {
      if (result.kind === "decoded") emit({ kind: "processing", measurement: { runId, inputId: item.inputId,
        startedMonotonicMs: t2, endedMonotonicMs: performance.now(),
        marks: { ...result.material.marks, ingressJsonMs: ingressJsonMs.get(item.inputId) ?? null } } });
      ingressJsonMs.delete(item.inputId);
    }
    return true;
  }

  // One item per turn so frames that arrive meanwhile queue in the mailbox (T1 to T2 is a real queue).
  function schedulePump(): void {
    if (pumpScheduled || stopping != null) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      if (stopping != null) return;
      if (processOne()) schedulePump(); else resumeIfDrained();
    });
  }

  function startConnect(): void {
    connect().catch(() => scheduleReconnect());
  }

  function scheduleReconnect(): void {
    if (stopping != null || reconnectTimer != null) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; startConnect(); }, RECONNECT_MS);
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

  function onFrame(ws: WebSocket, raw: RawData): void {
    const t0 = performance.now();
    if (overloaded || stopping != null) return;
    const bytes = toBuffer(raw);
    const entry = clock();
    if (bytes.byteLength <= CONTROL_PEEK_BYTES) {
      const head = peekHead(bytes);
      if (head?.type === "ping") {
        if (typeof head.pingId === "string") ws.send(JSON.stringify({ type: "pong", pingId: head.pingId }), () => {});
        return;
      }
      // start is accepted and dropped in P2: no diagnostic reason or observation kind can carry it; the real dmdata start belongs to P3.
      if (head?.type === "start" || head?.type === "pong") return;
      if (head?.type === "error") { ws.terminate(); return; }
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
      origin: "live", kind: "ws", frame: bytes });
    if (ingressed.kind === "rejected") { recordRejected(ingressed.diagnostic, entry.wallTimeMs); return; }
    const { item } = ingressed;
    // The priority reason is the validated outer shape only; meaning stays with parser and units.
    const envelope: MailboxEnvelope = { messageId: inputId, runId, t0MonotonicMs: entry.monotonicMs,
      enqueuedMonotonicMs: clock().monotonicMs, payload: { kind: "parser", item },
      priorityReason: item.headType === "VXSE43" || item.headType === "VXSE45" ? "eewCandidate" : "normal" };
    const t1 = performance.now();
    const result = mailbox.enqueue(envelope);
    if (result.kind === "rejected") {
      if (result.reason !== "draining") overload(result.reason, ws, entry.wallTimeMs);
      return;
    }
    lastAccepted = { sequence: lastSequence, inputId };
    if (config.observe != null) ingressJsonMs.set(inputId, ingressed.ingressJsonMs);
    emit({ kind: "marker", point: "T1", runId, inputId, monotonicMs: t1 });
    schedulePump();
  }

  function connect(): Promise<void> {
    return new Promise<void>((resolveOpen, rejectOpen) => {
      let ws: WebSocket;
      // The URL may carry a credential: neither this error nor any event keeps it.
      try { ws = new WebSocket(config.wsUrl); } catch { rejectOpen(new Error("WebSocket connection failed")); return; }
      let opened = false;
      socket = ws;
      ws.on("open", () => { opened = true; resolveOpen(); });
      ws.on("message", (raw) => { if (socket === ws) onFrame(ws, raw); });
      ws.on("error", () => { /* close follows */ });
      ws.on("close", () => {
        if (!opened) { if (socket === ws) socket = null; rejectOpen(new Error("WebSocket connection failed")); return; }
        if (socket !== ws) return;
        socket = null;
        if (stopping != null) return;
        dispatchLost();
        scheduleReconnect();
      });
    });
  }

  function tick(): void {
    if (stopping != null) return;
    const now = clock();
    root.tick(root.state, now);
    // P2-A10-AC13: the tick itself is the liveness answer; there is no engine worker (R60).
    mailbox.recordWorkerResponse(now.monotonicMs);
    const stalled = mailbox.isStalled(now.monotonicMs);
    const stats = mailbox.stats(now.monotonicMs);
    const changed = root.setWorker({ state: stalled ? "stalled" : "healthy",
      lastProgressAtMonotonicMs: stats.lastProgressMonotonicMs, lastResponseAtMonotonicMs: stats.lastWorkerResponseMonotonicMs });
    if (changed) server.heartbeat();
    if (saving) return;
    saving = true;
    // A broken invariant takes the process down (I/O failures come back as failed/uncertain results); ignored while stopping.
    root.driveCheckpoint().catch((error) => { if (stopping == null) throw error; }).finally(() => { saving = false; });
  }
  const tickTimer = setInterval(tick, TICK_MS);

  const stop = (): Promise<ShutdownSummary> => stopping ??= (async () => {
    clearInterval(tickTimer);
    if (reconnectTimer != null) clearTimeout(reconnectTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const ws = socket;
    socket = null;
    ws?.terminate();
    try { return await root.shutdownRuntime(root.state, lastAccepted?.sequence ?? 0, clock()); }
    finally { await server.close(); }
  })();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // P2-A1-PROBE: startup publishes the checking snapshot; the probe result arrives asynchronously.
  void root.probeNotificationChannels().then((channels) => {
    if (stopping == null) root.dispatch(root.state, { kind: "notificationProbeCompleted", channels, clock: clock() });
  });

  try { await connect(); }
  catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return { displayPort: server.port, stop };
}

export { startP2Host };
export type { P2HostConfig };
