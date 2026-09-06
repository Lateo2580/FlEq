import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join, resolve } from "node:path";
import { format } from "node:util";
import { DEFAULT_CONFIG } from "../../types";
import { createDisplayAdapter } from "../../ui/display-adapter";
import { startDisplayRuntime, type DisplayRuntime, type DisplayRuntimeOptions } from "../display/runtime";
import { StandbyStateStore } from "../display/standby-state-store";
import { WeatherPromotionStore } from "../display/weather-promotion-store";
import type { DisplayServerMessage, DisplayStateSnapshotV1 } from "../display/types";
import { DailyQuakeCounter } from "../messages/daily-quake-counter";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartCorrelatorFactoryContext,
} from "../messages/legacy-counterpart-correlator";
import { createMessageHandler } from "../messages/message-router";
import { SummaryWindowTracker } from "../messages/summary-tracker";
import { Vpwp50DetailCache } from "../messages/vpwp50-detail-cache";
import { createDisplaySink } from "../monitor/display-sink";
import { ReplayClock, ReplayScheduler } from "./replay-clock";
import {
  canonicalJson,
  createReplaySideEffects,
  prepareReplayStateDir,
  type ReplaySideEffects,
  stateRelative,
} from "./replay-side-effects";
import {
  loadVpBs50ReplayInputs,
  vpbs50ReplayInputDigest,
  type Vpbs50ReplayInput,
} from "./vpbs50-envelope";

export interface Vpbs50ReplayOptions {
  fixturePaths: readonly string[];
  stateDir: string;
  displayPort?: number;
  intervalMs?: number;
  hold?: boolean;
  checkoutRoot?: string;
}

export interface GuardedDisplayRuntime {
  transport: { port(): number; clientCount(): number };
  stop(): Promise<void>;
}

export function validateReplayDisplayPort(requestedPort: number): void {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error("--display-port must be an integer from 0 to 65535");
  }
  if (requestedPort === 7788) throw new Error("--display-port 7788 is reserved for production");
}

export async function startGuardedReplayDisplay<T extends GuardedDisplayRuntime>(
  requestedPort: number,
  start: (port: number) => Promise<T>,
): Promise<T> {
  validateReplayDisplayPort(requestedPort);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const runtime = await start(requestedPort);
    if (runtime.transport.port() !== 7788) return runtime;
    await runtime.stop();
  }
  throw new Error("display port allocator returned reserved port 7788 three times");
}

export interface ReplayProbeMessage {
  event: string;
  message: DisplayServerMessage;
}

export function isInitialReplaySnapshotFrame(frame: ReplayProbeMessage): boolean {
  return frame.event === "snapshot"
    && frame.message.type === "snapshot"
    && frame.message.snapshot.replay?.step === 0;
}

export function isFinalReplayStateFrame(
  frame: ReplayProbeMessage,
  expected: { step: number; total: number; inputDigest: string; seq: number },
): boolean {
  return frame.event === "state"
    && frame.message.type === "state"
    && frame.message.snapshot.replay?.step === expected.step
    && frame.message.snapshot.replay.total === expected.total
    && frame.message.snapshot.replay.inputDigest === expected.inputDigest
    && frame.message.snapshot.seq === expected.seq;
}

class ReplaySseProbe {
  private readonly messages: ReplayProbeMessage[] = [];
  private readonly firstWaiters: Array<(message: ReplayProbeMessage) => void> = [];
  private readonly waiters: Array<{
    predicate: (message: ReplayProbeMessage) => boolean;
    resolve: (message: ReplayProbeMessage) => void;
  }> = [];
  private closeRequest: (() => void) | null = null;

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const request = get(`${url}/events`, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`replay SSE returned HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        response.setEncoding("utf8");
        let buffer = "";
        response.on("data", (chunk: string) => {
          buffer += chunk;
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.acceptFrame(frame);
          }
        });
        response.on("error", reject);
        this.closeRequest = () => request.destroy();
        resolvePromise();
      });
      request.on("error", reject);
    });
  }

  private acceptFrame(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0 || event === "ping") return;
    const parsed = JSON.parse(data.join("\n")) as DisplayServerMessage;
    const probeMessage = { event, message: parsed };
    const isFirst = this.messages.length === 0;
    this.messages.push(probeMessage);
    if (isFirst) {
      for (const resolveFirst of this.firstWaiters.splice(0)) resolveFirst(probeMessage);
    }
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (!waiter.predicate(probeMessage)) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(probeMessage);
    }
  }

  waitForFirst(): Promise<ReplayProbeMessage> {
    const first = this.messages[0];
    if (first != null) return Promise.resolve(first);
    return new Promise((resolvePromise) => this.firstWaiters.push(resolvePromise));
  }

  waitFor(predicate: (message: ReplayProbeMessage) => boolean): Promise<ReplayProbeMessage> {
    const existing = this.messages.find(predicate);
    if (existing != null) return Promise.resolve(existing);
    return new Promise((resolvePromise) => this.waiters.push({ predicate, resolve: resolvePromise }));
  }

  close(): void {
    this.closeRequest?.();
    this.closeRequest = null;
  }
}

async function assertHealth(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const request = get(`${url}/healthz`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { ok?: unknown };
          if (response.statusCode !== 200 || parsed.ok !== true) {
            throw new Error("replay health check failed");
          }
          resolvePromise();
        } catch (cause) {
          reject(cause);
        }
      });
    });
    request.on("error", reject);
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function appendEvent(path: string, record: unknown): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function cacheFiles(stateDir: string): string[] {
  const root = join(stateDir, "data");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(stateRelative(stateDir, path));
    }
  };
  walk(root);
  return files;
}

async function wallSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function waitForExternalReplayClient(
  runtime: GuardedDisplayRuntime,
  sleep: (ms: number) => Promise<void> = wallSleep,
): Promise<void> {
  while (runtime.transport.clientCount() < 2) await sleep(50);
}

function waitForSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolvePromise();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function assertOccurrenceFinal(snapshot: DisplayStateSnapshotV1): void {
  const entries = (snapshot.standbyItems ?? [])
    .filter((item) => item.kind === "briefing")
    .flatMap((item) => item.data.entries);
  if (entries.length !== 1 || entries[0]?.phenomenonKind !== "linearRainObserved") {
    throw new Error("VPBS50 replay final state did not replace prediction with one occurrence");
  }
}

export function buildReplayInjectedRecord(input: Vpbs50ReplayInput, route: string): object {
  return {
    type: "replay.injected",
    ordinal: input.ordinal,
    fixture: input.fixtureRelativePath,
    fixtureSha256: input.sha256,
    headType: "VPBS50",
    businessTime: input.reportDateTime,
    route,
  };
}

export function buildReplayFinalRecord(input: {
  step: number;
  total: number;
  inputDigest: string;
  finalSnapshotSha256: string;
  cacheTouchedPaths: readonly string[];
  eewLogger: { attempts: number; suppressed: number };
  notifier: { attempts: number; suppressed: number };
}): object {
  return {
    type: "replay.final",
    step: input.step,
    total: input.total,
    inputDigest: input.inputDigest,
    finalSnapshotSha256: input.finalSnapshotSha256,
    cacheTouchedPaths: [...input.cacheTouchedPaths],
    sideEffects: {
      eewLogger: { ...input.eewLogger },
      notifier: { ...input.notifier },
    },
  };
}

export function createReplayRunnerResources(stateDir: string): {
  sideEffects: ReplaySideEffects;
  cache: Vpwp50DetailCache;
} {
  return {
    sideEffects: createReplaySideEffects(),
    cache: new Vpwp50DetailCache({ persistRoot: stateDir }),
  };
}

export async function runVpBs50Replay(options: Vpbs50ReplayOptions): Promise<void> {
  const checkoutRoot = resolve(options.checkoutRoot ?? process.cwd());
  const inputs = loadVpBs50ReplayInputs(options.fixturePaths, checkoutRoot);
  const intervalMs = options.intervalMs ?? 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("--interval must be a non-negative integer");
  const requestedPort = options.displayPort ?? 0;
  validateReplayDisplayPort(requestedPort);
  const stateDir = prepareReplayStateDir(options.stateDir, checkoutRoot);
  const eventsPath = join(stateDir, "events.jsonl");
  const cliPath = join(stateDir, "cli.txt");
  const finalPath = join(stateDir, "final-state.json");
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });

  const clock = new ReplayClock(inputs[0].reportDateTimeMs);
  const scheduler = new ReplayScheduler(clock);
  const inputDigest = vpbs50ReplayInputDigest(inputs);
  const replay = { step: 0, total: 2, inputDigest };
  const { sideEffects, cache } = createReplayRunnerResources(stateDir);
  const standby = new StandbyStateStore();
  const promotions = new WeatherPromotionStore();
  const display = createDisplayAdapter();
  const runtimeOptions: DisplayRuntimeOptions = {
    now: () => clock.nowMs(),
    timeoutScheduler: scheduler,
    replayMetadata: () => ({
      clock: { mode: "replay", now: clock.nowIso() },
      replay: { ...replay },
    }),
    startTimers: false,
  };
  let runtime: DisplayRuntime | null = null;
  let probe: ReplaySseProbe | null = null;
  const correlatorRef: { current: LegacyCounterpartCorrelator | null } = { current: null };
  const cliLines: string[] = [];
  try {
    runtime = await startGuardedReplayDisplay(requestedPort, async (port) => {
      const started = await startDisplayRuntime(
        { ...DEFAULT_CONFIG, apiKey: "", display: true, displayHost: "127.0.0.1", displayPort: port },
        display,
        {
          tsunami: () => null,
          weather: () => undefined,
          landslide: () => undefined,
          standbyItems: () => standby.snapshotItems(),
          weatherPromotions: () => promotions,
          standbySweep: (nowMs) => standby.sweep(nowMs),
          standbyTickerGroupKeys: () => standby.activeTickerGroupKeys(),
        },
        undefined,
        runtimeOptions,
      );
      if (started == null) throw new Error("replay display runtime failed to start");
      return started;
    });
    const actualPort = runtime.transport.port();
    const url = `http://127.0.0.1:${actualPort}`;
    await assertHealth(url);
    probe = new ReplaySseProbe();
    const initialPromise = probe.waitForFirst();
    await probe.connect(url);
    const initialFrame = await initialPromise;
    if (!isInitialReplaySnapshotFrame(initialFrame)) {
      throw new Error("replay first SSE frame is not the step 0 snapshot");
    }
    console.log(`replay.ready url=${url}/ actualPort=${actualPort}`);
    if (options.hold === true) await waitForExternalReplayClient(runtime);

    const sink = createDisplaySink({
      standby: {
        applyEvent: (event, nowMs) => standby.applyEvent(event, nowMs),
        briefingCardGeneration: () => standby.briefingCardGeneration(),
        reconcileBriefingCard: (sourceKey, event, nowMs) =>
          standby.reconcileBriefingCard(sourceKey, event, nowMs),
        snapshotBriefingCard: () => standby.snapshotBriefingCard(),
      },
      promotions,
      weatherViews: { vpws50: () => undefined, vpww56: () => undefined },
      getHub: () => runtime?.hub ?? null,
      now: () => clock.nowMs(),
    });
    let currentRoute: string | null = null;
    let routeTapCount = 0;
    const handler = createMessageHandler({
      display,
      displaySink: sink,
      clock,
      displayReceiptClock: clock,
      displayReceiptTimerScheduler: scheduler,
      eewLogger: sideEffects.eewLogger,
      notifier: sideEffects.notifier,
      vpwp50Cache: cache,
      summaryTracker: new SummaryWindowTracker(),
      dailyQuakeCounter: new DailyQuakeCounter(clock.nowMs()),
      routeTaps: [({ route }) => { currentRoute = route; routeTapCount += 1; }],
      legacyCounterpartCorrelatorFactory: (context: LegacyCounterpartCorrelatorFactoryContext) => {
        const correlator = new LegacyCounterpartCorrelator({
          clock,
          timerScheduler: scheduler,
          onAction: context.actionSink,
          onLifecycleEvent: context.lifecycleEventSink,
        });
        correlatorRef.current = correlator;
        return correlator;
      },
    });
    for (const input of inputs) {
      clock.advanceTo(input.reportDateTimeMs);
      replay.step = input.ordinal;
      currentRoute = null;
      routeTapCount = 0;
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]): void => {
        const line = format(...args);
        cliLines.push(line);
        originalConsoleLog(...args);
      };
      try {
        handler.handler(input.message);
      } finally {
        console.log = originalConsoleLog;
      }
      if (currentRoute == null || routeTapCount !== 1) {
        throw new Error("replay message did not cross the router route tap exactly once");
      }
      runtime.hub.markExternalStateDirty();
      appendEvent(eventsPath, buildReplayInjectedRecord(input, currentRoute));
      if (input.ordinal < inputs.length) await wallSleep(intervalMs);
    }
    writeFileSync(cliPath, cliLines.length === 0 ? "" : `${cliLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    handler.flushAndDisposeVolcanoBuffer();
    cache.flush();
    const sweep = standby.sweep(clock.nowMs());
    if (sweep.viewChanged) runtime.hub.markExternalStateDirty();
    scheduler.drainDue();
    correlatorRef.current?.flushDue();
    handler.disposeLegacyCounterpartCorrelator();
    const flushed = runtime.hub.flushReplayState();
    if (!flushed.emitted || flushed.degradationLevel !== 0) {
      throw new Error("replay final display state was not emitted at degradation level 0");
    }
    const frame = await probe.waitFor((candidate) => isFinalReplayStateFrame(candidate, {
      step: replay.total,
      total: replay.total,
      inputDigest,
      seq: flushed.seq,
    }));
    if (frame.message.type !== "state") throw new Error("replay final SSE frame type mismatch");
    const frameJson = canonicalJson(frame.message.snapshot);
    const runtimeJson = canonicalJson(flushed.snapshot);
    if (frameJson !== runtimeJson) throw new Error("replay SSE final state differs from runtime snapshot");
    assertOccurrenceFinal(flushed.snapshot);
    writeFileSync(finalPath, frameJson, { encoding: "utf8", flag: "wx" });

    const routerState = handler.getReplayQuiescence();
    const hubState = runtime.hub.getReplayQuiescence();
    if (
      routerState.pendingEnvelopes !== 0
      || routerState.serializerOwnerActive
      || scheduler.pendingDueCount() !== 0
      || hubState.stateDirty
      || hubState.stateTimer
      || hubState.tickerSyncRetry
    ) throw new Error("replay final state is not quiescent");
    const secondFlush = runtime.hub.flushReplayState();
    if (secondFlush.emitted || canonicalJson(secondFlush.snapshot) !== frameJson) {
      throw new Error("replay final flush is not idempotent");
    }
    const finalRecord = buildReplayFinalRecord({
      step: replay.step,
      total: replay.total,
      inputDigest,
      finalSnapshotSha256: sha256(frameJson),
      cacheTouchedPaths: cacheFiles(stateDir),
      eewLogger: sideEffects.eew,
      notifier: sideEffects.notifications,
    });
    appendEvent(eventsPath, finalRecord);
    console.log(`replay.final snapshot=${finalPath} events=${eventsPath}`);
    if (options.hold === true) await waitForSignal();
  } finally {
    probe?.close();
    scheduler.dispose();
    if (runtime != null) await runtime.stop();
  }
}
