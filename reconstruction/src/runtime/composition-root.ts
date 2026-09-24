import { promises as fileSystem, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  CheckpointRequest,
  CheckpointResult,
  ClockReading,
  DiagnosticEvent,
  DiagnosticReadQuery,
  DiagnosticReadResult,
  DiagnosticSinkResult,
  MailboxControl,
  ParserDiagnosticProjection,
  RestoreUnitResult,
  RuntimeState,
  RuntimeInput,
  NotificationResult,
  RuntimeEffect,
  RuntimeUnitStates,
  RuntimeUnitId,
  ShutdownPendingCounts,
  ShutdownStageResult,
  RuntimeStep,
  ShutdownSummary,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type { NotificationAbortRequest, NotificationAttempt, NotificationChannel, NotificationChannelState } from "../../contracts/p2-notification-delivery.types";
import { validateAppConfig } from "../app-config/app-config";
import type { AppConfig } from "../app-config/app-config";
import { CheckpointCoordinator } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap, Correlation } from "../checkpoint/checkpoint";
import { PersistentDiagnosticSink, projectParserDiagnostic } from "../checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../checkpoint/persistent-diagnostic-sink";
import { Mailbox } from "../mailbox/mailbox";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, runNotificationAttempt } from "../notification-delivery/adapter";
import { applyNotificationResult, selectNotificationAttempt } from "../notification-delivery/notification-delivery";
import { eewUnitCodec, reduceEewUnit, toEewView } from "../units/eew/eew-unit";
import { reduceWeatherCurrentUnit, toWeatherCurrentView, weatherCurrentUnitCodec } from "../units/weather-current/weather-current-unit";
import {
  reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, weatherTimeseriesUnitCodec,
} from "../units/weather-timeseries/weather-timeseries-unit";
import { completeDiagnostic } from "./runtime-diagnostic";
import { reduceRuntime } from "./shared-runtime";

// A3 wiring of delivered units (A4 U-E, A5 U-W, A6 U-F). Notification (A7) links here on delivery.
const linkedUnitCodecs: CodecMap<RuntimeUnitStates> = {
  "U-E": eewUnitCodec, "U-W": weatherCurrentUnitCodec, "U-F": weatherTimeseriesUnitCodec,
};
const linkedRuntimeCalls = { reduceEewUnit, toEewView, reduceWeatherCurrentUnit, toWeatherCurrentView,
  reduceWeatherTimeseriesUnit, toWeatherTimeseriesView, selectNotificationAttempt, applyNotificationResult } as const;

type ShutdownHooks = Readonly<{
  drainMailbox?: (deadlineMonotonicMs: number, active: () => boolean) => Promise<void>;
  finalizeBatchesAndSideEffects?: (deadlineMonotonicMs: number, active: () => boolean) =>
    Promise<Pick<ShutdownPendingCounts, "batches" | "notificationAttempts">>;
  closeWorker?: (deadlineMonotonicMs: number) => Promise<void>;
}>;

type CompositionOptions = Readonly<{
  clock?: () => ClockReading;
  checkpointFileSystem?: CheckpointFileSystem;
  diagnosticFileSystem?: DiagnosticFileSystem;
  mailbox?: Mailbox;
  notificationAdapter?: Readonly<{
    run: (attempt: NotificationAttempt, clock: () => ClockReading) => Promise<NotificationResult>;
    abort: (request: NotificationAbortRequest, stopByMonotonicMs: number, clock: () => ClockReading) => Promise<unknown>;
  }>;
  runtimeCalls?: Parameters<typeof reduceRuntime>[2];
  shutdownHooks?: ShutdownHooks;
  reportFailure?: (event: DiagnosticEvent) => void;
  onMeasurements?: (measurements: readonly CheckpointMeasurement[]) => void;
}>;

function systemClock(): ClockReading {
  return { wallTimeMs: Date.now(), monotonicMs: performance.now() };
}

function nodeCheckpointFileSystem(): CheckpointFileSystem {
  return {
    unlinkSync(path) {
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
    readFile(path) {
      try { return readFileSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async mkdir(path) { await fileSystem.mkdir(path, { recursive: true }); },
    async open(path) {
      await fileSystem.mkdir(dirname(path), { recursive: true });
      const handle = await fileSystem.open(path, "w");
      return {
        async write(data) { await handle.writeFile(data); },
        async sync() { await handle.sync(); },
        async close() { await handle.close(); },
      };
    },
    async rename(from, to) { await fileSystem.rename(from, to); },
    async syncDirectory(path) {
      const handle = await fileSystem.open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    },
  };
}

function nodeDiagnosticFileSystem(): DiagnosticFileSystem {
  return {
    async mkdir(path) { await fileSystem.mkdir(path, { recursive: true }); },
    async appendFile(path, data) { await fileSystem.appendFile(path, data, "utf8"); },
    async readLastByte(path) {
      const handle = await fileSystem.open(path, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (handle == null) return null;
      try {
        const { size } = await handle.stat();
        if (size === 0) return null;
        const byte = Buffer.alloc(1);
        const { bytesRead } = await handle.read(byte, 0, 1, size - 1);
        if (bytesRead !== 1) throw new Error("diagnostic tail unavailable");
        return byte[0];
      } finally { await handle.close(); }
    },
    async writeFile(path, data) { await fileSystem.writeFile(path, data, "utf8"); },
    async rename(from, to) { await fileSystem.rename(from, to); },
    async readFile(path) { return fileSystem.readFile(path, "utf8"); },
    async files(path) {
      let names: string[];
      try { names = await fileSystem.readdir(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return Promise.all(names.map(async (name) => {
        const details = await fileSystem.stat(`${path}/${name}`);
        return { name, size: details.size, mtimeMs: details.mtimeMs };
      }));
    },
    async unlink(path) { await fileSystem.unlink(path); },
  };
}

async function within(work: (active: () => boolean) => Promise<void>, deadline: number,
  clock: () => ClockReading): Promise<ShutdownStageResult> {
  const milliseconds = deadline - clock().monotonicMs;
  if (milliseconds <= 0) return { kind: "deadlineExceeded" };
  let active = true;
  const isActive = () => active && clock().monotonicMs < deadline;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<ShutdownStageResult>((resolve) => {
    timer = setTimeout(() => { active = false; resolve({ kind: "deadlineExceeded" }); }, milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([work(isActive).then((): ShutdownStageResult => isActive()
      ? { kind: "completed" } : { kind: "deadlineExceeded" },
      (): ShutdownStageResult => isActive() ? { kind: "failed", reason: "operationFailed" } : { kind: "deadlineExceeded" }), timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
    active = false;
  }
}

class RuntimeCompositionRoot {
  readonly mailbox: Mailbox;
  readonly diagnostics: PersistentDiagnosticSink;
  readonly checkpoint: CheckpointCoordinator;
  private contributions: Partial<Record<RuntimeUnitId, Map<number, readonly string[] | null>>> = {};
  private readonly clock: () => ClockReading;
  private readonly shutdownHooks: ShutdownHooks;
  private readonly runtimeCalls: Parameters<typeof reduceRuntime>[2];
  private readonly notificationAdapter: NonNullable<CompositionOptions["notificationAdapter"]>;
  private readonly notificationOperations: Record<NotificationChannel,
    { attemptId: string; terminal: Promise<void> } | null> = { desktop: null, sound: null };
  private onNotificationDispatchFailure: ((error: unknown) => void) | null = null;
  private readonly onMeasurements: (measurements: readonly CheckpointMeasurement[]) => void;
  private current: RuntimeState | null = null;
  private disconnectedAt: number | null = null;
  private lastDiagnosticTick = -Infinity;
  private checkpointOperation: {
    attemptId: string;
    completed: boolean;
    result: Promise<CheckpointResult | null>;
  } | null = null;

  constructor(configInput: AppConfig, codecs: CodecMap<RuntimeUnitStates>, options: CompositionOptions = {}) {
    const config = validateAppConfig(configInput);
    this.clock = options.clock ?? systemClock;
    this.shutdownHooks = options.shutdownHooks ?? {};
    this.runtimeCalls = { ...(options.runtimeCalls ?? linkedRuntimeCalls), codecs };
    this.notificationAdapter = options.notificationAdapter ?? { run: runNotificationAttempt, abort: abortNotificationAttempt };
    this.onMeasurements = options.onMeasurements ?? (() => {});
    this.mailbox = options.mailbox ?? new Mailbox();
    this.diagnostics = new PersistentDiagnosticSink(config.diagnosticDirectory,
      options.diagnosticFileSystem ?? nodeDiagnosticFileSystem(), () => this.clock().wallTimeMs,
      options.reportFailure ?? ((event) => { process.stderr.write(`${JSON.stringify(event)}\n`); }));
    this.checkpoint = new CheckpointCoordinator(config.stateDirectory, codecs,
      options.checkpointFileSystem ?? nodeCheckpointFileSystem(), this.clock,
      (event) => { this.diagnostics.enqueueDiagnostic(event); });
  }

  get state(): RuntimeState {
    if (this.current == null) throw new Error("runtime has not received its initial state");
    return this.current;
  }

  get lastDisconnectedAt(): number | null { return this.disconnectedAt; }

  async probeNotificationChannels(): Promise<Readonly<Record<NotificationChannel,
    Extract<NotificationChannelState, { kind: "idle" | "unavailable" }>>>> {
    const desktop = probeDesktopBackend();
    let sound: Extract<NotificationChannelState, { kind: "idle" | "unavailable" }> = { kind: "unavailable", reason: "backendMissing" };
    let directory: string | null = null;
    try {
      directory = await fileSystem.mkdtemp(join(tmpdir(), "fleq-p2-probe-"));
      const silent = Buffer.from(readFileSync("reconstruction/assets/sounds/weather-info.wav"));
      silent.fill(0, 44);
      const path = join(directory, "silent.wav");
      await fileSystem.writeFile(path, silent);
      if ((await probeSoundBackend(path, this.clock)).kind === "delivered") sound = { kind: "idle" };
    } catch { /* A failed probe leaves the sound channel unavailable. */ }
    finally { if (directory != null) await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); }
    return { desktop, sound };
  }

  startRuntime(runId: string, clock: ClockReading,
    notificationChannels: Extract<RuntimeInput, { kind: "startup" }>["notificationChannels"]): RuntimeStep {
    if (this.current != null) throw new Error("runtime already started");
    const restored = { "U-E": this.restoreUnit("U-E"), "U-W": this.restoreUnit("U-W"),
      "U-F": this.restoreUnit("U-F") };
    const step = reduceRuntime(null, { kind: "startup", runId, clock, restored, notificationChannels }, this.runtimeCalls);
    this.current = step.state;
    for (const unit of ["U-E", "U-W", "U-F"] as const) {
      const base = restored[unit].kind === "restored" ? restored[unit].envelope.generation : 0;
      for (let generation = base + 1; generation <= step.state.units[unit].persistence.currentGeneration; generation++) {
        this.contributions[unit] ??= new Map();
        this.contributions[unit]!.set(generation,
          Object.hasOwn(step.generationInputIds, unit) ? step.generationInputIds[unit]! : null);
      }
    }
    step.diagnostics.forEach((event) => this.enqueueDiagnostic(event));
    this.dispatchNotifications(step);
    return step;
  }

  // startRuntime is the only initial state adoption path; the argument never overrides it.
  dispatch(state: RuntimeState, input: RuntimeInput,
    correlationByUnit: Readonly<Partial<Record<UnitId, Correlation>>> = {}): RuntimeStep {
    const previous = this.state;
    const result = input.kind === "mailboxCompleted" && input.completion.runId === previous.runId
      && input.completion.kind === "control" && input.completion.control.kind === "checkpointResult"
      ? input.completion.control.result : null;
    if (result != null && input.kind === "mailboxCompleted" && !this.checkpoint.validateResult(previous, result))
      return this.control(previous, { kind: "deadline", clock: input.clock });
    const step = reduceRuntime(previous, input, this.runtimeCalls);
    const contributions = { ...this.contributions };
    for (const unit of ["U-E", "U-W", "U-F"] as const) {
      const before = previous.units[unit].persistence;
      const after = step.state.units[unit].persistence;
      if (after.currentGeneration > before.currentGeneration
        || (after.savedGeneration ?? 0) > (before.savedGeneration ?? 0)) {
        const ledger = new Map(contributions[unit]);
        // AC10 proves the entire generation interval within this one reducer step.
        for (let generation = before.currentGeneration + 1; generation <= after.currentGeneration; generation++)
          ledger.set(generation, Object.hasOwn(step.generationInputIds, unit) ? step.generationInputIds[unit]! : null);
        for (const generation of ledger.keys())
          if (generation <= (after.savedGeneration ?? 0)) ledger.delete(generation);
        contributions[unit] = ledger;
      }
    }
    this.checkCorrelations(step.state, correlationByUnit, contributions);
    this.current = step.state;
    if (input.kind === "connectionLost") this.disconnectedAt = input.clock.wallTimeMs;
    this.contributions = contributions;
    if (result != null && input.kind === "mailboxCompleted") {
      this.checkpoint.resultMetadata(previous, result, input.clock);
      if (this.checkpointOperation?.attemptId === result.attemptId && this.checkpointOperation.completed)
        this.checkpointOperation = null;
    }
    step.diagnostics.forEach((event) => this.enqueueDiagnostic(event));
    this.dispatchNotifications(step, input.kind === "notificationResult" ? input.result.attemptId : null);
    return step;
  }

  private dispatchNotifications(step: RuntimeStep, completedAttemptId: string | null = null): void {
    for (const request of step.abortRequests) {
      if (request.attemptId === completedAttemptId) continue;
      const name = (["desktop", "sound"] as const).find((candidate) =>
        this.notificationOperations[candidate]?.attemptId === request.attemptId);
      if (name == null) continue; // The run result already settled in this reducer step.
      const channel = step.state.notificationChannels[name];
      if (channel.kind !== "stopping" || channel.attempt.attemptId !== request.attemptId)
        throw new Error("A1 abort request has no stopping channel");
      void this.notificationAdapter.abort(request, channel.stopByMonotonicMs, this.clock).catch(() => {});
    }
    for (const attempt of step.notificationAttempts) {
      const previous = this.notificationOperations[attempt.channel];
      if (previous != null && previous.attemptId !== completedAttemptId)
        throw new Error("notification channel already has an operation");
      // The executor catches a synchronous run throw; only adapter errors become failed terminals.
      const operation = new Promise<NotificationResult>((resolve) => {
        resolve(this.notificationAdapter.run(attempt, this.clock));
      }).catch((): NotificationResult => ({ kind: "failed", reason: "adapterError",
        attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: this.clock() }))
        .then((result) => {
          try { this.dispatch(this.state, { kind: "notificationResult", result }); }
          catch (error) {
            if (this.onNotificationDispatchFailure != null) this.onNotificationDispatchFailure(error);
            // An old shutdown waiter may still observe terminal; keep failures after return unhandled.
            else void Promise.reject(error);
            return;
          }
          // Dispatch can start the successor. Never erase it or discard tracking on a reducer failure.
          if (this.notificationOperations[attempt.channel]?.attemptId === attempt.attemptId)
            this.notificationOperations[attempt.channel] = null;
        });
      this.notificationOperations[attempt.channel] = { attemptId: attempt.attemptId, terminal: operation };
    }
  }

  tick(state: RuntimeState, clock: ClockReading): RuntimeStep {
    const step = this.control(state, { kind: "deadline", clock });
    if (clock.monotonicMs - this.lastDiagnosticTick >= 1_000) {
      this.lastDiagnosticTick = clock.monotonicMs;
      for (const details of this.mailbox.drainDiagnostics(clock.monotonicMs))
        this.enqueueDiagnostic(completeDiagnostic(details, clock, step.state.runId));
    }
    return step;
  }

  restoreUnit(unit: UnitId): RestoreUnitResult {
    return this.checkpoint.restoreUnit(unit);
  }

  scheduleCheckpoint(state: RuntimeState, clock: ClockReading, runId: string,
    correlationByUnit: Readonly<Partial<Record<UnitId, Correlation>>> = {}) {
    const current = this.state;
    if (current.shutdown.stage !== "running") return null;
    this.checkCorrelations(current, correlationByUnit);
    const correlations = this.knownCorrelations(current, correlationByUnit);
    const scheduled = this.checkpoint.scheduleCheckpoint(current, clock, runId, correlations);
    if (scheduled != null) {
      this.dispatch(state, { kind: "checkpointCaptured", capture: scheduled.capture });
      if (scheduled.result != null) this.checkpointOperation = {
        attemptId: scheduled.result.attemptId, completed: true, result: Promise.resolve(scheduled.result),
      };
      this.onMeasurements(scheduled.measurements);
    }
    return scheduled;
  }

  private inputIds(state: RuntimeState, unit: RuntimeUnitId,
    contributions = this.contributions): readonly string[] | null {
    const { currentGeneration, savedGeneration } = state.units[unit].persistence;
    const ledger = contributions[unit];
    if (state.restoration[unit].kind === "unavailable" || ledger == null) return null;
    const ids = new Set<string>();
    for (let generation = (savedGeneration ?? 0) + 1; generation <= currentGeneration; generation++) {
      if (!ledger.has(generation) || ledger.get(generation) == null) return null;
      for (const id of ledger.get(generation)!) ids.add(id);
    }
    return [...ids];
  }

  private checkCorrelations(state: RuntimeState,
    provided: Readonly<Partial<Record<UnitId, Correlation>>>, contributions = this.contributions) {
    for (const [unit, correlation] of Object.entries(provided) as [RuntimeUnitId, Correlation][]) {
      if (correlation == null) continue;
      const progress = state.units[unit].persistence;
      if (progress.dirtySince == null || progress.currentGeneration === progress.savedGeneration) continue;
      const ids = this.inputIds(state, unit, contributions);
      if (ids == null || ids.length !== correlation.inputIds.length
        || ids.some((id) => !correlation.inputIds.includes(id)))
        throw new Error(`unverified checkpoint correlation for ${unit}`);
    }
  }

  private knownCorrelations(state: RuntimeState,
    provided: Readonly<Partial<Record<UnitId, Correlation>>> = {}): Readonly<Partial<Record<UnitId, Correlation>>> {
    const result: Partial<Record<UnitId, Correlation>> = {};
    for (const unit of ["U-E", "U-W", "U-F"] as const) {
      const ids = this.inputIds(state, unit);
      if (ids != null) result[unit] = { inputIds: ids,
        retryReason: provided[unit]?.retryReason ?? this.checkpoint.retryReason(unit) };
    }
    return result;
  }

  async executeCheckpoint(request: CheckpointRequest, runId: string, inputIds: readonly string[],
    retryReason: CheckpointMeasurement["retryReason"]): Promise<Readonly<{
      result: CheckpointResult; measurements: readonly CheckpointMeasurement[];
    }>> {
    if (this.current?.shutdown.stage === "workerClose" || this.current?.shutdown.stage === "completed")
      throw new Error("checkpoint worker is stopping");
    return this.trackCheckpoint(request.attemptId,
      () => this.checkpoint.executeCheckpoint(request, runId, inputIds, retryReason));
  }

  private trackCheckpoint<T extends Readonly<{ result: CheckpointResult | null; measurements: readonly CheckpointMeasurement[] }>>(
    attemptId: string, work: () => Promise<T>,
  ): Promise<T> {
    if (this.checkpointOperation != null) throw new Error("checkpoint attempt already executed");
    const output = work().then((executed) => {
      tracked.completed = true;
      if (executed.measurements.length !== 0) this.onMeasurements(executed.measurements);
      if (executed.result == null && this.checkpointOperation === tracked) this.checkpointOperation = null;
      return executed;
    });
    const tracked = { attemptId, completed: false, result: output.then((executed) => executed.result) };
    this.checkpointOperation = tracked;
    void tracked.result.catch(() => { if (this.checkpointOperation === tracked) this.checkpointOperation = null; });
    return output;
  }

  applyCheckpointResult(state: RuntimeState, result: CheckpointResult, clock: ClockReading): RuntimeStep {
    return this.control(state, { kind: "checkpointResult", result, clock });
  }

  async resolveUncertain(state: RuntimeState, unit: UnitId, attemptId: string,
    clock: ClockReading): Promise<RuntimeStep> {
    let result: CheckpointResult | null = null;
    const pending = this.checkpointOperation;
    const stage = this.state.shutdown.stage;
    if (pending == null && stage !== "workerClose" && stage !== "completed") {
      const reconciled = await this.trackCheckpoint(attemptId,
        () => this.checkpoint.resolveUncertain(this.state, unit, attemptId, clock));
      result = reconciled.result;
    } else if (pending?.completed && pending.attemptId === attemptId) {
      const completed = await pending.result;
      if (this.checkpointOperation === pending) result = completed;
    }
    return result == null ? this.control(state, { kind: "deadline", clock })
      : this.applyCheckpointResult(state, result, this.clock());
  }

  private control(state: RuntimeState, control: MailboxControl): RuntimeStep {
    const clock = control.clock;
    return this.dispatch(state, { kind: "mailboxCompleted", clock, completion: {
      kind: "control", messageId: control.kind === "checkpointResult" ? control.result.attemptId : control.kind,
      runId: this.state.runId,
      encodedByteLength: control.kind === "checkpointResult" ? control.result.encodedByteLength : 0,
      startedMonotonicMs: clock.monotonicMs, completedMonotonicMs: clock.monotonicMs, control,
    } });
  }

  enqueueDiagnostic(event: DiagnosticEvent): DiagnosticSinkResult {
    return this.diagnostics.enqueueDiagnostic(event);
  }

  readDiagnostics(query: DiagnosticReadQuery): Promise<DiagnosticReadResult> {
    return this.diagnostics.readDiagnostics(query);
  }

  projectParserDiagnostic(parser: ParserDiagnostic, runId: string, timestamp: number): ParserDiagnosticProjection {
    return projectParserDiagnostic(parser, runId, timestamp);
  }

  async shutdownRuntime(state: RuntimeState, acceptedThroughSequence: number,
    clock: ClockReading): Promise<ShutdownSummary> {
    if (this.state.shutdown.stage !== "running") throw new Error("shutdown already started");
    const failure: { error?: unknown } = {};
    this.onNotificationDispatchFailure = (error) => {
      if (!Object.hasOwn(failure, "error")) failure.error = error;
    };
    try {
      let step = this.control(state, { kind: "shutdownRequested", acceptedThroughSequence, clock });
      let batches = 0;
      let notificationAttempts = 0;
      let workers = 1;
      let summarySaved = false;
      while (step.effects.length !== 0) {
        const effect: RuntimeEffect = step.effects[0];
        const stage = this.state.shutdown.stage;
        if (stage === "running" || stage === "completed") throw new Error("unexpected shutdown effect");
        if (effect.kind === "stopInputAndDrainMailbox") this.mailbox.beginDrain(this.clock().monotonicMs);
        let batchFailed = false;
        const result = await within(async (active) => {
          switch (effect.kind) {
            case "stopInputAndDrainMailbox":
              await this.shutdownHooks.drainMailbox?.(effect.deadlineMonotonicMs, active);
              break;
            case "finalizeNotificationDelivery": {
              // A1 has already issued shutdown aborts; run promises own the terminal results.
              batches = 1;
              await Promise.all([
                Promise.all(Object.values(this.notificationOperations).flatMap((pending) => pending == null ? [] : [pending.terminal])),
                (async () => {
                  try {
                    const pending = await this.shutdownHooks.finalizeBatchesAndSideEffects?.(effect.deadlineMonotonicMs, active)
                      ?? { batches: 0, notificationAttempts: 0 };
                    if (active()) batches = pending.batches;
                  } catch { batchFailed = true; }
                })(),
              ]);
              break;
            }
            case "startFinalCheckpoints":
              await this.saveFinalGenerations(active);
              break;
            case "closeRuntimeWorkers":
              await this.diagnostics.persistShutdownSummary(effect.summary, active);
              summarySaved = true;
              if (!active()) return;
              await this.shutdownHooks.closeWorker?.(effect.deadlineMonotonicMs);
              if (active()) workers = 0;
              break;
          }
        }, effect.deadlineMonotonicMs, this.clock);
        if (Object.hasOwn(failure, "error")) throw failure.error;
        if (effect.kind === "finalizeNotificationDelivery")
          notificationAttempts = (["desktop", "sound"] as const).filter((channel) =>
            this.notificationOperations[channel] != null || this.state.notificationChannels[channel].kind === "isolated").length;
        const stats = this.mailbox.stats(this.clock().monotonicMs);
        step = this.dispatch(this.state, { kind: "shutdownStageResult", stage,
          result: batchFailed ? { kind: "failed", reason: "operationFailed" } : result,
          pending: { mailboxPending: stats.pendingItems, mailboxInFlight: stats.inFlightItems,
            batches, notificationAttempts, unsavedUnits: 0, workers },
          clock: this.clock(), droppedDiagnostics: this.diagnostics.droppedCounts() });
      }
      if (step.shutdownSummary == null) throw new Error("shutdown did not produce a summary");
      const summary = step.shutdownSummary;
      // A1 owns both summaries. A failed final delivery is not reported as a successful persistence.
      const deadline = this.state.shutdown.deadlines.workerCloseMonotonicMs!;
      if (summarySaved && this.clock().monotonicMs < deadline) {
        const persisted = await within((active) => this.diagnostics.persistShutdownSummary(summary, active), deadline, this.clock);
        if (Object.hasOwn(failure, "error")) throw failure.error;
        if (persisted.kind !== "completed")
          throw new Error("final shutdown summary could not be persisted");
      }
      return summary;
    } finally { this.onNotificationDispatchFailure = null; }
  }

  private async saveFinalGenerations(active: () => boolean): Promise<void> {
    const attempted = new Set<UnitId>();
    while (active()) {
      const pending = this.checkpointOperation;
      if (pending != null) {
        const result = await pending.result;
        if (this.checkpointOperation === pending && result != null)
          this.applyCheckpointResult(this.state, result, this.clock());
        continue;
      }
      const current = this.state;
      const clock = this.clock();
      const correlations = this.knownCorrelations(current);
      const scheduled = this.checkpoint.scheduleCheckpoint(current, clock, current.runId, correlations, true, attempted);
      if (scheduled == null) return;
      this.dispatch(current, { kind: "checkpointCaptured", capture: scheduled.capture });
      this.onMeasurements(scheduled.measurements);
      const unit = scheduled.capture.unit;
      attempted.add(unit);
      if (scheduled.request == null) {
        this.applyCheckpointResult(this.state, scheduled.result, this.clock());
        continue;
      }
      const correlation = correlations[unit]!;
      if (!active()) return;
      const executed = await this.executeCheckpoint(scheduled.request, current.runId,
        correlation.inputIds, correlation.retryReason);
      this.applyCheckpointResult(this.state, executed.result, this.clock());
    }
  }
}

export { RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem, nodeDiagnosticFileSystem };
export type { CompositionOptions, ShutdownHooks };
