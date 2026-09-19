import { promises as fileSystem, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

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
  RuntimeStep,
  ShutdownSummary,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import { validateAppConfig } from "../app-config/app-config";
import type { AppConfig } from "../app-config/app-config";
import { CheckpointCoordinator } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap, Correlation } from "../checkpoint/checkpoint";
import { PersistentDiagnosticSink, projectParserDiagnostic } from "../checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../checkpoint/persistent-diagnostic-sink";
import { Mailbox } from "../mailbox/mailbox";
import { completeDiagnostic } from "./runtime-diagnostic";
import { reduceRuntime } from "./shared-runtime";

type ShutdownUpdate<Units extends Readonly<Partial<Record<UnitId, unknown>>>> = Readonly<{
  state: RuntimeState<Units>;
  correlationByUnit?: Readonly<Partial<Record<UnitId, Correlation>>>;
}>;

type ShutdownHooks<Units extends Readonly<Partial<Record<UnitId, unknown>>>> = Readonly<{
  drainMailbox?: (deadlineMonotonicMs: number, state: RuntimeState<Units>) => Promise<ShutdownUpdate<Units> | void>;
  finalizeBatchesAndSideEffects?: (deadlineMonotonicMs: number, state: RuntimeState<Units>) => Promise<number | Readonly<{
    remainingBatches: number;
  }> & ShutdownUpdate<Units>>;
  closeWorker?: (deadlineMonotonicMs: number) => Promise<void>;
}>;

type CompositionOptions<Units extends Readonly<Partial<Record<UnitId, unknown>>>> = Readonly<{
  clock?: () => ClockReading;
  checkpointFileSystem?: CheckpointFileSystem;
  diagnosticFileSystem?: DiagnosticFileSystem;
  mailbox?: Mailbox;
  shutdownHooks?: ShutdownHooks<Units>;
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

async function within<T>(work: (active: () => boolean) => Promise<T>, milliseconds: number,
  clock: () => ClockReading): Promise<Readonly<{ completed: true; value: T }> | Readonly<{ completed: false }>> {
  const deadline = clock().monotonicMs + milliseconds;
  let active = true;
  const isActive = () => active && clock().monotonicMs < deadline;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<Readonly<{ completed: false }>>((resolve) => {
    timer = setTimeout(() => { active = false; resolve({ completed: false }); }, milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([work(isActive).then((value) => isActive()
      ? { completed: true as const, value } : { completed: false as const }, () => ({ completed: false as const })), timeout]);
  } finally {
    if (timer != null) clearTimeout(timer);
    active = false;
  }
}

class RuntimeCompositionRoot<UnitStates extends Readonly<Partial<Record<UnitId, unknown>>>> {
  readonly mailbox: Mailbox;
  readonly diagnostics: PersistentDiagnosticSink;
  readonly checkpoint: CheckpointCoordinator<UnitStates>;
  private readonly correlations: Partial<Record<UnitId, Readonly<{ inputIds: readonly string[]; generation: number }>>> = {};
  private readonly clock: () => ClockReading;
  private readonly shutdownHooks: ShutdownHooks<UnitStates>;
  private readonly onMeasurements: (measurements: readonly CheckpointMeasurement[]) => void;
  private shutdownState: RuntimeState<UnitStates> | null = null;
  private checkpointOperation: {
    attemptId: string;
    completed: boolean;
    result: Promise<CheckpointResult | null>;
  } | null = null;

  constructor(configInput: AppConfig, codecs: CodecMap<UnitStates>, options: CompositionOptions<UnitStates> = {}) {
    const config = validateAppConfig(configInput);
    this.clock = options.clock ?? systemClock;
    this.shutdownHooks = options.shutdownHooks ?? {};
    this.onMeasurements = options.onMeasurements ?? (() => {});
    this.mailbox = options.mailbox ?? new Mailbox();
    this.diagnostics = new PersistentDiagnosticSink(config.diagnosticDirectory,
      options.diagnosticFileSystem ?? nodeDiagnosticFileSystem(), () => this.clock().wallTimeMs,
      options.reportFailure ?? ((event) => { process.stderr.write(`${JSON.stringify(event)}\n`); }));
    this.checkpoint = new CheckpointCoordinator(config.stateDirectory, codecs,
      options.checkpointFileSystem ?? nodeCheckpointFileSystem(), this.clock,
      (event) => { this.diagnostics.enqueueDiagnostic(event); });
  }

  restoreUnit(unit: UnitId): RestoreUnitResult {
    return this.checkpoint.restoreUnit(unit);
  }

  scheduleCheckpoint(
    state: RuntimeState<UnitStates>,
    clock: ClockReading,
    runId: string,
    correlationByUnit: Readonly<Partial<Record<UnitId, Correlation>>>,
  ) {
    if (this.shutdownState != null) return null;
    this.rememberCorrelations(state, correlationByUnit);
    const scheduled = this.checkpoint.scheduleCheckpoint(state, clock, runId, correlationByUnit);
    if (scheduled != null) this.onMeasurements(scheduled.measurements);
    return scheduled;
  }

  private rememberCorrelations(state: RuntimeState<UnitStates>, correlationByUnit: Readonly<Partial<Record<UnitId, Correlation>>>) {
    for (const [unit, correlation] of Object.entries(correlationByUnit) as [UnitId, Correlation | undefined][]) {
      const generation = state.persistence[unit]?.currentGeneration;
      if (correlation != null && generation != null) this.correlations[unit] = { inputIds: [...correlation.inputIds], generation };
    }
  }

  async executeCheckpoint(request: CheckpointRequest, runId: string, inputIds: readonly string[],
    retryReason: CheckpointMeasurement["retryReason"]): Promise<Readonly<{
      result: CheckpointResult; measurements: readonly CheckpointMeasurement[];
    }>> {
    if (this.shutdownState?.shutdown === "stopping") throw new Error("checkpoint worker is stopping");
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

  applyCheckpointResult(state: RuntimeState<UnitStates>, result: CheckpointResult,
    clock: ClockReading): RuntimeStep<UnitStates> {
    const step = this.control(this.shutdownState ?? state, { kind: "checkpointResult", result, clock });
    // A1-b removes only duplicate persistence application, NOT resultMetadata's writer/retry bookkeeping.
    const metadata = this.checkpoint.resultMetadata(step.state, result, clock);
    const updated = { ...step, state: { ...step.state, persistence: metadata.persistence },
      diagnostics: [...step.diagnostics, ...metadata.diagnostics] };
    if (this.shutdownState != null) this.shutdownState = updated.state;
    if (this.checkpointOperation?.attemptId === result.attemptId && this.checkpointOperation.completed)
      this.checkpointOperation = null;
    return updated;
  }

  async resolveUncertain(state: RuntimeState<UnitStates>, unit: UnitId, attemptId: string,
    clock: ClockReading): Promise<RuntimeStep<UnitStates>> {
    let result: CheckpointResult | null = null;
    const pending = this.checkpointOperation;
    if (pending == null && this.shutdownState?.shutdown !== "stopping") {
      const reconciled = await this.trackCheckpoint(attemptId,
        () => this.checkpoint.resolveUncertain(this.shutdownState ?? state, unit, attemptId, clock));
      result = reconciled.result;
    } else if (pending?.completed && pending.attemptId === attemptId) {
      const completed = await pending.result;
      if (this.checkpointOperation === pending) result = completed;
    }
    return result == null ? { state: this.shutdownState ?? state, changedUnits: [], checkpointRequests: [],
      notificationIntents: [], outcomes: [], views: [], diagnostics: [] }
      : this.applyCheckpointResult(state, result, this.clock());
  }

  private control(state: RuntimeState<UnitStates>, control: MailboxControl): RuntimeStep<UnitStates> {
    const clock = control.clock;
    return reduceRuntime(state, { kind: "mailboxCompleted", clock, completion: {
      kind: "control", messageId: control.kind === "checkpointResult" ? control.result.attemptId : control.kind,
      runId: control.kind === "checkpointResult" ? this.checkpoint.attemptRunId(control.result.attemptId) : "shutdown",
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

  async shutdownRuntime(state: RuntimeState<UnitStates>, acceptedThroughSequence: number,
    clock: ClockReading): Promise<ShutdownSummary> {
    const reasons: string[] = [];
    const runId = "shutdown";
    const started = completeDiagnostic({ level: "INFO", component: "shutdown", reason: "shutdownStarted" }, clock, runId);
    this.enqueueDiagnostic(started);
    if (this.shutdownState != null) throw new Error("shutdown already started");
    this.shutdownState = { ...this.control(state, { kind: "shutdownRequested", acceptedThroughSequence, clock }).state,
      shutdown: "draining" };
    this.mailbox.beginDrain(clock.monotonicMs);
    const drained = await within(() => this.shutdownHooks.drainMailbox?.(clock.monotonicMs + 10_000, this.shutdownState!)
      ?? Promise.resolve(), 10_000, this.clock);
    if (drained.completed && drained.value != null) this.adoptShutdownUpdate(drained.value);
    let stats = this.mailbox.stats(this.clock().monotonicMs);
    if (!drained.completed || stats.pendingItems !== 0 || stats.inFlightItems !== 0) reasons.push("mailboxNotDrained");

    this.shutdownPhase("finalizing");
    const finalized = await within(() => this.shutdownHooks.finalizeBatchesAndSideEffects?.(this.clock().monotonicMs + 5_000,
      this.shutdownState!) ?? Promise.resolve(0), 5_000, this.clock);
    if (finalized.completed && typeof finalized.value !== "number") this.adoptShutdownUpdate(finalized.value);
    const remainingBatches = finalized.completed
      ? typeof finalized.value === "number" ? finalized.value : finalized.value.remainingBatches : 1;
    if (remainingBatches !== 0) reasons.push("batchOrSideEffectsNotFinalized");
    const finalizationAt = finalized.completed ? this.clock().wallTimeMs : null;

    const save = await within((active) => this.saveFinalGenerations(active), 10_000, this.clock);
    if (!save.completed) reasons.push("finalSaveTimedOut");
    const unsaved = (Object.entries(this.shutdownState.persistence) as [UnitId, RuntimeState<UnitStates>["persistence"][UnitId]][])
      .filter(([, status]) => status == null || status.kind !== "saved" || status.currentGeneration !== status.savedGeneration)
      .map(([unit]) => unit);
    if (unsaved.length !== 0) {
      reasons.push(`unsaved:${unsaved.join(",")}`);
      this.enqueueDiagnostic(completeDiagnostic({ level: "ERROR", component: "shutdown",
        reason: "shutdownUnsavedUnits", count: unsaved.length }, this.clock(), runId));
    }

    // No business deadline is applied after finalizationAt.
    this.shutdownState = { ...this.shutdownState, shutdown: "stopping" };
    stats = this.mailbox.stats(this.clock().monotonicMs);
    const code = reasons.includes("mailboxNotDrained") || reasons.includes("batchOrSideEffectsNotFinalized") ? 3
      : unsaved.length !== 0 || reasons.includes("finalSaveTimedOut") ? 2
        : 0;
    const summary: ShutdownSummary = {
      code, requestedAt: clock.wallTimeMs, finalizationAt, completedAt: this.clock().wallTimeMs,
      acceptedThroughSequence, pendingInputs: stats.pendingItems, inFlightInputs: stats.inFlightItems,
      persistence: { ...this.shutdownState.persistence }, reasons: [...reasons],
      droppedDiagnostics: this.diagnostics.droppedCounts(),
    };
    const closeDeadline = this.clock().monotonicMs + 5_000;
    const closed = await within(async (active) => {
      // Persist the final-state snapshot before the worker can disappear.
      await this.diagnostics.persistShutdownSummary(summary);
      if (!active()) return;
      try {
        await this.shutdownHooks.closeWorker?.(closeDeadline);
      } catch (error) {
        if (active()) await this.diagnostics.persistShutdownSummary({ ...summary,
          code: code === 0 ? 4 : code, completedAt: this.clock().wallTimeMs,
          reasons: [...reasons, "workerCloseTimedOut"] });
        throw error;
      }
    }, 5_000, this.clock);
    if (!closed.completed) reasons.push("workerCloseTimedOut");
    return { ...summary, code: code === 0 && !closed.completed ? 4 : code,
      completedAt: this.clock().wallTimeMs, reasons: Object.freeze([...reasons]),
      droppedDiagnostics: this.diagnostics.droppedCounts() };
  }

  private adoptShutdownUpdate(update: ShutdownUpdate<UnitStates>): void {
    // Unit reducers are supplied by the caller; A3 does not invent their transitions.
    const clock = this.clock();
    const persistence = { ...update.state.persistence };
    for (const [unit, latest] of Object.entries(this.shutdownState!.persistence) as [UnitId,
      RuntimeState<UnitStates>["persistence"][UnitId]][]) {
      const next = persistence[unit];
      // A hook may have awaited an ack while reducing its input snapshot.
      if (latest?.savedGeneration != null && next != null
        && latest.savedGeneration > (next.savedGeneration ?? 0)) {
        persistence[unit] = { ...next, kind: latest.savedGeneration === next.currentGeneration ? "saved" : "pending",
          savedGeneration: latest.savedGeneration, savedCapturedAt: latest.savedCapturedAt, savedAckAt: latest.savedAckAt,
          dirtySince: latest.savedGeneration === next.currentGeneration ? null : next.dirtySince };
      }
    }
    const reduced = this.control(update.state, { kind: "deadline", clock }).state;
    this.shutdownState = { ...reduced, persistence };
    this.rememberCorrelations(this.shutdownState, update.correlationByUnit ?? {});
  }

  private shutdownPhase(shutdown: RuntimeState<UnitStates>["shutdown"]): void {
    const clock = this.clock();
    this.shutdownState = { ...this.control(this.shutdownState!, { kind: "deadline", clock }).state, shutdown };
  }

  private async saveFinalGenerations(active: () => boolean): Promise<void> {
    const attempted = new Set<UnitId>();
    while (active()) {
      const pending = this.checkpointOperation;
      if (pending != null) {
        const result = await pending.result;
        if (this.checkpointOperation === pending && result != null)
          this.applyCheckpointResult(this.shutdownState!, result, this.clock());
        continue; // Re-evaluate final generations after the pre-existing operation's ack.
      }
      const current = this.shutdownState!;
      const clock = this.clock();
      const correlations = Object.fromEntries((Object.entries(this.correlations) as [UnitId,
        Readonly<{ inputIds: readonly string[]; generation: number }> | undefined][]).flatMap(([unit, correlation]) =>
        correlation != null && current.persistence[unit]?.currentGeneration === correlation.generation
          ? [[unit, { inputIds: correlation.inputIds, retryReason: this.checkpoint.retryReason(unit) }]] : []));
      const scheduled = this.checkpoint.scheduleCheckpoint(current, clock, "shutdown", correlations, true, attempted);
      if (scheduled == null) return;
      this.onMeasurements(scheduled.measurements);
      const unit = scheduled.request?.unit ?? scheduled.result!.unit;
      attempted.add(unit);
      if (scheduled.request == null) {
        this.applyCheckpointResult(this.shutdownState!, scheduled.result!, this.clock());
        continue;
      }
      const correlation = correlations[unit]!;
      if (!active()) return;
      const executed = await this.executeCheckpoint(scheduled.request, "shutdown",
        correlation.inputIds, correlation.retryReason);
      this.applyCheckpointResult(this.shutdownState!, executed.result, this.clock());
    }
  }
}

export { RuntimeCompositionRoot, nodeCheckpointFileSystem, nodeDiagnosticFileSystem };
export type { CompositionOptions, ShutdownHooks };
