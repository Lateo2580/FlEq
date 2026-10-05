import { randomUUID } from "node:crypto";
import { promises as fileSystem, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  ClockReading,
  DiagnosticEvent,
  DiagnosticReadQuery,
  DiagnosticReadResult,
  DiagnosticSinkResult,
  MailboxEnvelope,
  NotificationIntent,
  NotificationIntentUpdate,
  ParserDiagnosticProjection,
  RuntimeAdmissionCounts,
  RuntimeDisplayChange,
  RuntimeInput,
  RuntimePublishedOutcome,
  NotificationResult,
  RuntimeEffect,
  RuntimeUnitStates,
  RuntimeUnitId,
  ShutdownPendingCounts,
  ShutdownStageResult,
  ShutdownSummary,
} from "../../contracts/p2-shared-runtime.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import type { ExecutionPlace, OwnerOutput, OwnerReply, OwnerRequest, ParserEnvelope } from "../../contracts/p3-execution-split.types";
import type {
  NotificationAbortRequest, NotificationAttempt, NotificationChannel, NotificationChannelState, NotificationDeliveryState,
  NotificationDeliveryStep, NotificationSelection,
} from "../../contracts/p2-notification-delivery.types";
import type {
  DisplayConnectionView, DisplaySnapshot, DisplayVersion, DisplayWorkerView, SnapshotProjectionInput, SnapshotProjectionState,
} from "../../contracts/p2-snapshot-sse.types";
import { validateAppConfig } from "../app-config/app-config";
import type { AppConfig } from "../app-config/app-config";
import { CheckpointWriter } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap } from "../checkpoint/checkpoint";
import { PersistentDiagnosticSink, projectParserDiagnostic } from "../checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../checkpoint/persistent-diagnostic-sink";
import { Mailbox } from "../mailbox/mailbox";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, resolveRepoPath, runNotificationAttempt } from "../notification-delivery/adapter";
import { applyNotificationResult, selectNotificationAttempt } from "../notification-delivery/notification-delivery";
import { eewUnit } from "../units/eew/eew-unit";
import { weatherCurrentUnit } from "../units/weather-current/weather-current-unit";
import { weatherTimeseriesUnit } from "../units/weather-timeseries/weather-timeseries-unit";
import { dateValue, projectSnapshot } from "../view-projector/view-projector";
import { completeDiagnostic } from "./runtime-diagnostic";
import {
  applyDeltas, confirmOutput, initialConfirmation, isEmptyOutput, lostConfirmation, observeStage, requestShutdown,
  validateProbe, verifyCoverage,
} from "./shared-runtime";
import type { MirrorUnit, PublisherState } from "./shared-runtime";
import { executionPlaces, placeOfHeadType, runtimeUnits } from "./unit-coverage";

// A3 wiring of delivered units (A4 U-E, A5 U-W, A6 U-F). Notification (A7) links here on delivery.
// P3-UNIT-TABLE-001: the one table of unit functions. A unit lane adds its row here and nowhere else.
const linkedUnitTable = { "U-E": eewUnit, "U-W": weatherCurrentUnit, "U-F": weatherTimeseriesUnit } satisfies UnitTable;
// Durable rows give the codec, ephemeral rows none; the literal keeps each unit's own codec type (no `as`).
const codecOf = <K extends RuntimeUnitId>(module: UnitModule<K>) =>
  module.persistence.kind === "durable" ? module.persistence.codec : undefined;
const linkedUnitCodecs: CodecMap<RuntimeUnitStates> = {
  "U-E": codecOf(linkedUnitTable["U-E"]), "U-W": codecOf(linkedUnitTable["U-W"]), "U-F": codecOf(linkedUnitTable["U-F"]),
} satisfies Record<RuntimeUnitId, unknown>;
const linkedRuntimeCalls = { units: linkedUnitTable, selectNotificationAttempt, applyNotificationResult } as const;
// Execution places in unit order; one owner per place (D-P3-1).
const places: readonly ExecutionPlace[] = [...new Set(runtimeUnits.map((unit) => executionPlaces[unit]))];
const channelNames = ["desktop", "sound"] as const;

type ShutdownHooks = Readonly<{
  drainMailbox?: (deadlineMonotonicMs: number, active: () => boolean) => Promise<void>;
  finalizeBatchesAndSideEffects?: (deadlineMonotonicMs: number, active: () => boolean) =>
    Promise<Pick<ShutdownPendingCounts, "batches" | "notificationAttempts">>;
  closeWorker?: (deadlineMonotonicMs: number) => Promise<void>;
}>;

type NotificationCalls = Readonly<{
  selectNotificationAttempt?: (state: NotificationDeliveryState, clock: ClockReading) => NotificationSelection;
  applyNotificationResult?: (state: NotificationDeliveryState, result: NotificationResult, clock: ClockReading) => NotificationDeliveryStep;
}>;

type InputDone = Extract<OwnerReply, { kind: "inputDone" }>;
// A request before the publisher stamps it with its SentClock.
type OwnerRequestBody = OwnerRequest extends infer R ? R extends unknown ? Omit<R, "clock" | "sharedMs"> : never : never;

type CompositionOptions = Readonly<{
  // P3-C3A: the one way a request reaches an owner. The host posts it to the owner's thread.
  send: (place: ExecutionPlace, request: OwnerRequest) => void;
  clock?: () => ClockReading;
  // performance.timeOrigin + performance.now(), the real clock every thread shares (P3-C3A-CLOCK).
  sharedNow?: () => number;
  diagnosticFileSystem?: DiagnosticFileSystem;
  mailbox?: Mailbox;
  notificationAdapter?: Readonly<{
    run: (attempt: NotificationAttempt, clock: () => ClockReading) => Promise<NotificationResult>;
    abort: (request: NotificationAbortRequest, stopByMonotonicMs: number, clock: () => ClockReading) => Promise<unknown>;
  }>;
  notificationCalls?: NotificationCalls;
  // Confirmation scope limits come from the unit rows; the publisher never calls a unit reducer.
  units?: UnitTable;
  shutdownHooks?: ShutdownHooks;
  reportFailure?: (event: DiagnosticEvent) => void;
  onMeasurements?: (measurements: readonly CheckpointMeasurement[]) => void;
  // Each parser input once its owner answered and the mailbox settled it (the host's T2/decode/processing records).
  onInputDone?: (reply: InputDone) => void;
  // P2-A3-A8-LINK: without it snapshots are still projected (state kept) but not published.
  display?: Readonly<{
    publish: (snapshot: DisplaySnapshot) => void;
    onMarker?: (marker: Readonly<{ point: "T3"; clock: "node"; monotonicMs: number }>, version: DisplayVersion) => void;
    // Keeps /healthz and heartbeat on the same worker view as the snapshot (P2-A8-AC04).
    setWorker?: (worker: DisplayWorkerView) => void;
  }>;
}>;

type PublisherInput = Extract<RuntimeInput, { kind: "connectionLost" | "coverageVerified" | "notificationProbeCompleted" }>;
type ProjectedStep = Readonly<{ state: PublisherState; outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[] }>;

// A reserved attempt (P3-C3A-NOTIFY-ADOPT): the selected attempt waits for its owner to adopt the attempt count.
type Reservation = Readonly<{ requestId: string; attempt: NotificationAttempt; unit: RuntimeUnitId; key: string }>;
// One owner intentUpdate in flight: per owner and channel one reservation and one other update (P3-C3A-RES-09).
// keys: intents whose result is decided and in transit (out of selection and expiry). reserved: the intent a reservation
// names; it stays selectable, but no expiry update may overtake the owner's adoption with a stale attempt count.
type IntentRequest = Readonly<{ place: ExecutionPlace; channel: NotificationChannel; slot: "reservation" | "update";
  keys: readonly string[]; reserved: string | null }>;
type HeldUpdate = Readonly<{ unit: RuntimeUnitId; channel: NotificationChannel; updates: readonly NotificationIntentUpdate[];
  decisionClock: ClockReading; keys: readonly string[] }>;

const intentKey = (intent: Pick<NotificationIntent, "unit" | "id">) => JSON.stringify([intent.unit, intent.id]);
const sameIntent = (left: NotificationIntent, right: Pick<NotificationIntent, "id" | "unit" | "operation" | "subject" | "channel">) =>
  left.id === right.id && left.unit === right.unit && left.operation === right.operation
  && left.subject === right.subject && left.channel === right.channel;
const isParser = (envelope: MailboxEnvelope): envelope is ParserEnvelope => envelope.payload.kind === "parser";

function viewOf(unit: MirrorUnit) { return unit.view; }

// The one A1 state -> A8 input mapping; connection/worker come from the caller.
function snapshotInput(step: ProjectedStep, streamId: string, nowMs: number,
  connection: DisplayConnectionView, worker: DisplayWorkerView): SnapshotProjectionInput {
  const { state } = step;
  const date = new Date(nowMs);
  const eew = viewOf(state.mirror["U-E"]), weatherCurrent = viewOf(state.mirror["U-W"]), weatherTimeseries = viewOf(state.mirror["U-F"]);
  if (eew.unit !== "U-E" || weatherCurrent.unit !== "U-W" || weatherTimeseries.unit !== "U-F") throw new Error("mirror view of another unit");
  const admissionCounts: RuntimeAdmissionCounts = { "U-E": state.mirror["U-E"].admissionCounts,
    "U-W": state.mirror["U-W"].admissionCounts, "U-F": state.mirror["U-F"].admissionCounts };
  return {
    // An invalid clock is passed through unrounded; A8 rejects it as snapshotClockInvalid.
    streamId, generatedAt: Number.isNaN(date.getTime()) ? String(nowMs) : date.toISOString(), nowMs, connection, worker,
    persistence: { "U-E": state.mirror["U-E"].persistence, "U-W": state.mirror["U-W"].persistence,
      "U-F": state.mirror["U-F"].persistence },
    recovery: state.restoration, confirmation: state.confirmation, admissionCounts,
    notificationChannels: state.notificationChannels, channelProbeComplete: state.notificationProbeComplete,
    eew, weatherCurrent, weatherTimeseries, outcomes: step.outcomes, displayChanges: step.displayChanges,
  };
}

function systemClock(): ClockReading {
  return { wallTimeMs: Date.now(), monotonicMs: performance.now() };
}

// performance.timeOrigin + performance.now(): the real clock every thread shares (P3-C3A-CLOCK).
function sharedClock(): number {
  return performance.timeOrigin + performance.now();
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

// P3-C3A publisher (Node main): connection-side state, mailbox, snapshot, notification adapter and the checkpoint write
// right. Units live in the owners; this keeps their bounded mirror and talks to them only by OwnerRequest/OwnerReply.
class RuntimeCompositionRoot {
  readonly mailbox: Mailbox;
  readonly diagnostics: PersistentDiagnosticSink;
  readonly checkpoint: CheckpointWriter;
  private readonly sendRequest: CompositionOptions["send"];
  private readonly clock: () => ClockReading;
  private readonly sharedNow: () => number;
  private readonly units: UnitTable;
  private readonly shutdownHooks: ShutdownHooks;
  private readonly notificationCalls: NotificationCalls;
  private readonly notificationAdapter: NonNullable<CompositionOptions["notificationAdapter"]>;
  private readonly notificationOperations: Record<NotificationChannel,
    { attemptId: string; terminal: Promise<void> } | null> = { desktop: null, sound: null };
  private onNotificationDispatchFailure: ((error: unknown) => void) | null = null;
  private readonly onMeasurements: (measurements: readonly CheckpointMeasurement[]) => void;
  private readonly onInputDone: (reply: InputDone) => void;
  private current: PublisherState | null = null;
  private runId: string | null = null;
  // P3-C3A-OWNER-FAILURE (A): once an owner stopped unexpectedly nothing more is sent.
  private failure: { place: ExecutionPlace; cause: unknown } | null = null;
  private readonly restored = new Map<ExecutionPlace, Extract<OwnerReply, { kind: "restored" }>>();
  private requestSequence = 0;
  // P3-C3A-RES-09: the requests each owner has not answered yet, by kind.
  private readonly outstanding: Record<ExecutionPlace, { deadline: boolean; shutdownInput: boolean }> = {
    urgent: { deadline: false, shutdownInput: false }, weatherCurrent: { deadline: false, shutdownInput: false },
    deferred: { deadline: false, shutdownInput: false } };
  private readonly inFlightInputs = new Map<ExecutionPlace, ParserEnvelope>();
  private readonly intentRequests = new Map<string, IntentRequest>();
  private readonly inFlightKeys = new Set<string>();
  // The mailbox's completed count after this root's last complete(): a rise means the completion released its item.
  private mailboxCompleted: number;
  private reservations: Partial<Record<NotificationChannel, Reservation>> = {};
  private readonly heldUpdates: HeldUpdate[] = [];
  // AC09 step 1: after the shutdown input, no deadline or intent update is sent any more.
  private requestsStopped = false;
  private finalization: { cutoff: ClockReading | null; fixed: Set<ExecutionPlace>; closed: boolean } | null = null;
  private lateReplies = 0;
  private readonly waiters = new Set<() => void>();
  private disconnectedAt: number | null = null;
  // acceptedThroughSequence of the open loss; a later parser input sequence means the transport delivers again.
  private lostThroughSequence: number | null = null;
  private lastInputAt: number | null = null;
  // The snapshot carries the worker view of the last state change; /healthz and heartbeat carry the latest one.
  private snapshotWorker: DisplayWorkerView = { state: "healthy", lastProgressAtMonotonicMs: null, lastResponseAtMonotonicMs: null };
  private readonly display: CompositionOptions["display"];
  private streamId = "";
  private projection: SnapshotProjectionState | null = null;
  private noticeTimer: NodeJS.Timeout | null = null;
  private lastDiagnosticTick = -Infinity;

  constructor(configInput: AppConfig, codecs: CodecMap<RuntimeUnitStates>, options: CompositionOptions) {
    const config = validateAppConfig(configInput);
    this.sendRequest = options.send;
    this.clock = options.clock ?? systemClock;
    this.sharedNow = options.sharedNow ?? sharedClock;
    this.units = options.units ?? linkedUnitTable;
    this.shutdownHooks = options.shutdownHooks ?? {};
    this.notificationCalls = options.notificationCalls ?? { selectNotificationAttempt, applyNotificationResult };
    this.notificationAdapter = options.notificationAdapter ?? { run: runNotificationAttempt, abort: abortNotificationAttempt };
    this.onMeasurements = options.onMeasurements ?? (() => {});
    this.onInputDone = options.onInputDone ?? (() => {});
    this.mailbox = options.mailbox ?? new Mailbox();
    this.mailboxCompleted = this.mailbox.stats(0).completed;
    this.display = options.display;
    this.diagnostics = new PersistentDiagnosticSink(config.diagnosticDirectory,
      options.diagnosticFileSystem ?? nodeDiagnosticFileSystem(), () => this.clock().wallTimeMs,
      options.reportFailure ?? ((event) => { process.stderr.write(`${JSON.stringify(event)}\n`); }));
    this.checkpoint = new CheckpointWriter((unit) => codecs[unit] != null, (event) => { this.diagnostics.enqueueDiagnostic(event); });
  }

  get state(): PublisherState {
    if (this.current == null) throw new Error("runtime has not received its initial state");
    return this.current;
  }

  get lastDisconnectedAt(): number | null { return this.disconnectedAt; }

  // Replies an unfixed owner sent after the finalization deadline; counted, never adopted (P3-C3A-AC09).
  get lateReplyCount(): number { return this.lateReplies; }

  async probeNotificationChannels(): Promise<Readonly<Record<NotificationChannel,
    Extract<NotificationChannelState, { kind: "idle" | "unavailable" }>>>> {
    const desktop = probeDesktopBackend();
    let sound: Extract<NotificationChannelState, { kind: "idle" | "unavailable" }> = { kind: "unavailable", reason: "backendMissing" };
    let directory: string | null = null;
    try {
      directory = await fileSystem.mkdtemp(join(tmpdir(), "fleq-p2-probe-"));
      const silent = Buffer.from(readFileSync(resolveRepoPath("reconstruction/assets/sounds/weather-info.wav")));
      silent.fill(0, 44);
      const path = join(directory, "silent.wav");
      await fileSystem.writeFile(path, silent);
      if ((await probeSoundBackend(path, this.clock)).kind === "delivered") sound = { kind: "idle" };
    } catch { /* A failed probe leaves the sound channel unavailable. */ }
    finally { if (directory != null) await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); }
    return { desktop, sound };
  }

  private post(place: ExecutionPlace, request: OwnerRequestBody, clock = this.clock()): void {
    if (this.failure != null) return;
    this.sendRequest(place, { ...request, clock, sharedMs: this.sharedNow() });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  // Resolves once condition holds after some reply (or at once); an abandoned wait is dropped at the next wake.
  private until(condition: () => boolean, active: () => boolean = () => true): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.failure != null) { this.waiters.delete(check); reject(new Error(`execution owner ${this.failure.place} stopped`)); return; }
        if (condition() || !active()) { this.waiters.delete(check); resolve(); }
      };
      this.waiters.add(check);
      check();
    });
  }

  // P3-C3A-AC01: every owner restores and runs its startup step before the publisher builds its own state.
  async startRuntime(runId: string, clock: ClockReading,
    notificationChannels: Extract<RuntimeInput, { kind: "startup" }>["notificationChannels"]): Promise<void> {
    if (this.runId != null) throw new Error("runtime already started");
    if (runId.length === 0 || !Number.isFinite(clock.wallTimeMs) || !Number.isFinite(clock.monotonicMs)
      || notificationChannels == null || Object.keys(notificationChannels).length !== 2
      || channelNames.some((name) => notificationChannels[name]?.kind !== "idle"))
      throw new RangeError("invalid startup input");
    this.runId = runId;
    for (const place of places) this.post(place, { kind: "restore", runId }, clock);
    await this.until(() => places.every((place) => this.restored.has(place)));
    const mirror: Partial<Record<RuntimeUnitId, MirrorUnit>> = {};
    const restoration: Partial<Record<RuntimeUnitId, PublisherState["restoration"][RuntimeUnitId]>> = {};
    for (const place of places) for (const unit of this.restored.get(place)!.units) {
      mirror[unit.unit] = { persistence: unit.persistence, admissionCounts: unit.admissionCounts, view: unit.view,
        pendingIntents: unit.pendingIntents };
      restoration[unit.unit] = unit.restoration;
    }
    if (runtimeUnits.some((unit) => mirror[unit] == null || restoration[unit] == null)) throw new Error("an owner did not restore every unit");
    let state: PublisherState = {
      runId, mirror: { "U-E": mirror["U-E"]!, "U-W": mirror["U-W"]!, "U-F": mirror["U-F"]! },
      restoration: { "U-E": restoration["U-E"]!, "U-W": restoration["U-W"]!, "U-F": restoration["U-F"]! },
      confirmation: initialConfirmation(), notificationChannels, notificationProbeComplete: false,
      notificationDeadlines: { desktop: {}, sound: {} },
      shutdown: { stage: "running", acceptedThroughSequence: null, startedAt: null, finalizationAt: null,
        stageResults: {}, deadlines: { overallMonotonicMs: null, mailboxDrainMonotonicMs: null,
          sideEffectFinalizationMonotonicMs: null, finalCheckpointMonotonicMs: null, workerCloseMonotonicMs: null } },
    };
    const outcomes: RuntimePublishedOutcome[] = [];
    const displayChanges: RuntimeDisplayChange[] = [];
    for (const place of places) {
      const { output } = this.restored.get(place)!;
      state = { ...state, confirmation: confirmOutput(state.confirmation, this.units, output, clock, null) };
      outcomes.push(...output.outcomes);
      displayChanges.push(...output.displayChanges);
      output.diagnostics.forEach((event) => this.enqueueDiagnostic(event));
    }
    this.current = state;
    this.streamId = randomUUID();
    this.evaluateDelivery(clock);
    this.project(outcomes, displayChanges, clock);
  }

  // The one way a publisher input (not from an owner) changes the publisher state.
  dispatch(input: PublisherInput): void {
    const state = this.state;
    if (input.kind === "connectionLost") {
      if (!Number.isSafeInteger(input.acceptedThroughSequence) || input.acceptedThroughSequence < -1)
        throw new RangeError("invalid disconnect sequence");
      this.current = { ...state, confirmation: lostConfirmation(state.confirmation, this.units, input.acceptedThroughSequence) };
      this.disconnectedAt = input.clock.wallTimeMs;
      this.lostThroughSequence = input.acceptedThroughSequence;
    } else if (input.kind === "coverageVerified") {
      const confirmation = verifyCoverage(state.confirmation, this.units, state.runId, input);
      if (confirmation !== state.confirmation) this.current = { ...state, confirmation };
    } else if (!state.notificationProbeComplete) {
      validateProbe(input.channels);
      this.current = { ...state, notificationChannels: input.channels, notificationProbeComplete: true };
      const missing = channelNames.filter((name) => input.channels[name].kind === "unavailable").length;
      if (missing > 0) this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "notification-delivery",
        reason: "notificationAttemptFailed", count: missing }, input.clock, state.runId));
      this.evaluateDelivery(input.clock);
    }
    this.project([], [], input.clock);
  }

  // Every reply of every owner enters here, in the order each owner applied its requests.
  receive(place: ExecutionPlace, reply: OwnerReply): void {
    if (this.failure != null) return;
    switch (reply.kind) {
      case "restored":
        if (this.restored.has(place)) throw new Error("owner restored twice");
        this.restored.set(place, reply);
        break;
      case "inputDone": this.inputDone(place, reply); break;
      case "deadlineDone":
        this.outstanding[place].deadline = false;
        this.ownerOutput(place, reply.output, null);
        break;
      case "intentUpdateDone": this.intentUpdateDone(place, reply); break;
      case "checkpointDone": this.checkpointDone(place, reply); break;
      case "shutdownInputDone":
        this.outstanding[place].shutdownInput = false;
        this.ownerOutput(place, reply.output, null);
        break;
      case "finalizeDone": this.finalizeDone(place, reply); break;
      default: { const unknown: never = reply; throw new Error(`unknown owner reply ${String(unknown)}`); }
    }
    this.wake();
  }

  // P3-C3A-OWNER-FAILURE (author ruling A, until C3b): an owner that stops unexpectedly stops the process.
  ownerFailed(place: ExecutionPlace, cause: unknown): never {
    this.failure ??= { place, cause };
    this.wake();
    throw new Error(`execution owner ${place} stopped unexpectedly`, { cause });
  }

  // P3-C3A-AC09: replies from an owner that was not fixed before the finalization deadline are counted only.
  private late(place: ExecutionPlace): boolean {
    if (this.finalization?.closed !== true || this.finalization.fixed.has(place)) return false;
    this.countLate();
    return true;
  }

  // AC09: a late reply is only counted, as one WARN each (the sink folds repeats into count).
  private countLate(): void {
    this.lateReplies += 1;
    this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "runtime", reason: "ownerReplyLate", count: 1 },
      this.clock(), this.state.runId));
  }

  // The mirror and confirmation after one owner output; nothing is copied or projected for an empty one (E08).
  private absorb(place: ExecutionPlace, output: OwnerOutput, evidenceSequence: number | null, clock: ClockReading): boolean {
    if (this.late(place) || isEmptyOutput(output)) return false;
    const state = this.state;
    this.current = { ...state, mirror: applyDeltas(state.mirror, output.units),
      confirmation: confirmOutput(state.confirmation, this.units, output, clock, evidenceSequence) };
    output.diagnostics.forEach((event) => this.enqueueDiagnostic(event));
    return true;
  }

  private ownerOutput(place: ExecutionPlace, output: OwnerOutput, evidenceSequence: number | null): boolean {
    const clock = this.clock();
    if (!this.absorb(place, output, evidenceSequence, clock)) return false;
    this.evaluateDelivery(clock);
    this.project(output.outcomes, output.displayChanges, clock);
    return true;
  }

  // P2-A10-AC12: hand parser inputs to their owners; the mailbox keeps one in flight per execution place (P3-C3A-RES-01).
  pump(): void {
    if (this.current == null || this.failure != null) return;
    // After the drain stage nothing more goes to the owners: what is left stays counted as pending (Y1).
    const { stage } = this.state.shutdown;
    if (stage !== "running" && stage !== "mailboxDrain") return;
    for (;;) {
      const envelope = this.mailbox.takeNext(this.clock().monotonicMs);
      if (envelope == null) return;
      if (!isParser(envelope)) throw new Error("the mailbox holds parser items only");
      const place = placeOfHeadType(envelope.payload.item.headType);
      this.inFlightInputs.set(place, envelope);
      this.post(place, { kind: "input", envelope });
    }
  }

  // Waits until the mailbox has nothing pending or in flight, or until active() turns false (the drain stage).
  async drainInputs(active: () => boolean): Promise<void> {
    this.pump();
    await this.until(() => {
      const stats = this.mailbox.stats(this.clock().monotonicMs);
      return stats.pendingItems === 0 && this.inFlightInputs.size === 0;
    }, active);
  }

  private inputDone(place: ExecutionPlace, reply: InputDone): void {
    const { settlement } = reply;
    // Only a completion the mailbox accepts (it released that place's in-flight item, P3-C3A-AC03) is adopted (Y4).
    const { completed } = this.mailbox.complete(settlement);
    const released = completed > this.mailboxCompleted;
    this.mailboxCompleted = completed;
    if (!released) return;
    this.inFlightInputs.delete(place);
    const state = this.state;
    let reconnected = false;
    // A1 ignores an old run's completion, so it cannot end reconnecting either.
    if (this.lostThroughSequence != null && settlement.runId === state.runId && settlement.inputSequence > this.lostThroughSequence) {
      this.lostThroughSequence = null;
      reconnected = true;
    }
    if (!this.ownerOutput(place, reply.output, settlement.runId === state.runId ? settlement.inputSequence : null) && reconnected)
      this.project([], [], this.clock());
    this.onInputDone(reply);
    this.pump();
  }

  // The 1 s tick: each owner applies its own due deadlines on its deadline request (P3-C3A-DEADLINES). A deadline still
  // unanswered is not sent again; the next tick sends the latest clock (P3-C3A-AC15).
  tick(clock: ClockReading = this.clock()): void {
    const state = this.state;
    if (this.failure != null) return;
    if (!this.requestsStopped && state.shutdown.finalizationAt == null)
      for (const place of places) if (!this.outstanding[place].deadline) {
        this.outstanding[place].deadline = true;
        this.post(place, { kind: "deadline" }, clock);
      }
    this.evaluateDelivery(clock);
    this.project([], [], clock);
    if (clock.monotonicMs - this.lastDiagnosticTick >= 1_000) {
      this.lastDiagnosticTick = clock.monotonicMs;
      for (const details of this.mailbox.drainDiagnostics(clock.monotonicMs))
        this.enqueueDiagnostic(completeDiagnostic(details, clock, state.runId));
    }
  }

  // P2-A3-A8-LINK: every step is projected; rejected/unchanged states are kept, only projected is published.
  private project(outcomes: readonly RuntimePublishedOutcome[], displayChanges: readonly RuntimeDisplayChange[], clock: ClockReading): void {
    const state = this.state;
    // P2-A10-AC13: the host maps the mailbox judgement in; only shutdown completion is decided here.
    const stopped = state.shutdown.stage === "completed";
    const worker: DisplayWorkerView = stopped ? { ...this.snapshotWorker, state: "stopped" } : this.snapshotWorker;
    const result = projectSnapshot(snapshotInput({ state, outcomes, displayChanges }, this.streamId, clock.wallTimeMs,
      this.connectionView(state), worker), this.projection);
    this.projection = result.state;
    for (const details of result.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, state.runId));
    const display = this.display;
    if (display != null) {
      // A display callback failure surfaces like a notification dispatch failure, after state is adopted.
      const guard = (call: () => void) => { try { call(); } catch (error) { void Promise.reject(error); } };
      if (stopped) guard(() => display.setWorker?.(worker));
      if (result.kind === "projected") {
        const { streamId, semanticRevision, sequence } = result.snapshot;
        guard(() => display.onMarker?.({ point: "T3", clock: "node", monotonicMs: performance.now() },
          { streamId, semanticRevision, sequence }));
        guard(() => display.publish(result.snapshot));
      }
    }
    // P2-A8-NOTICE.ttl: the earliest expiry re-enters the existing tick; scans <= 64 notices.
    if (this.noticeTimer != null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (state.shutdown.stage !== "running" || result.state.notices.length === 0) return;
    // An invalid clock keeps notices (A8 clock rule: integer in the Date range); the next valid step reschedules.
    // A finite one (fractional, out of range) past the expiry would otherwise re-arm a 0 ms tick forever.
    if (!dateValue(clock.wallTimeMs)) return;
    const delay = Math.min(...result.state.notices.map((item) => item.expiresAt)) - clock.wallTimeMs;
    // Node turns a delay above 2^31-1 into 1 ms; clamp so a far wall-clock jump cannot spin the tick.
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.tick(this.clock());
    }, Math.min(Math.max(delay, 0), 2 ** 31 - 1));
    this.noticeTimer.unref();
  }

  // P2-A10-AC13: true when the state changed, so the host can emit the heartbeat at once.
  setWorker(view: DisplayWorkerView): boolean {
    const changed = view.state !== this.snapshotWorker.state;
    if (changed) this.snapshotWorker = view;
    try { this.display?.setWorker?.(view); } catch (error) { void Promise.reject(error); }
    return changed;
  }

  // P2-A10-AC13: lastInputAt is the wall clock at the WS receive callback, rejected inputs included.
  recordInput(wallTimeMs: number): void { this.lastInputAt = wallTimeMs; }

  // P3-C2-AC06: a well-formed start on the current WS ends reconnecting without waiting for data; confirmation state stays.
  recordConnected(): void { this.lostThroughSequence = null; }

  private connectionView(state: PublisherState): DisplayConnectionView {
    return { state: state.shutdown.stage !== "running" ? "stopped" : this.lostThroughSequence == null ? "connected" : "reconnecting",
      disconnectedAt: this.disconnectedAt, lastInputAt: this.lastInputAt };
  }

  // ---- notification (A7 selection over the mirror; P3-C3A-NOTIFY-ADOPT) ----

  private deliveryState(): NotificationDeliveryState {
    const state = this.state;
    return {
      intents: runtimeUnits.flatMap((unit) => state.mirror[unit].pendingIntents.filter((intent) =>
        !this.inFlightKeys.has(intentKey(intent)) && (intent.operation !== "normal" || state.mirror[unit].admissionCounts.normal === 0))),
      channels: state.notificationChannels, deadlines: state.notificationDeadlines,
    };
  }

  private slotBusy(place: ExecutionPlace, channel: NotificationChannel, slot: IntentRequest["slot"]): boolean {
    for (const request of this.intentRequests.values())
      if (request.place === place && request.channel === channel && request.slot === slot) return true;
    return false;
  }

  private sendIntentUpdate(unit: RuntimeUnitId, channel: NotificationChannel, slot: IntentRequest["slot"],
    updates: readonly NotificationIntentUpdate[], decisionClock: ClockReading, keys: readonly string[],
    reserved: string | null = null): string {
    const requestId = `${this.state.runId}:intent:${++this.requestSequence}`;
    const place = executionPlaces[unit];
    this.intentRequests.set(requestId, { place, channel, slot, keys, reserved });
    for (const key of keys) this.inFlightKeys.add(key);
    this.post(place, { kind: "intentUpdate", requestId, unit, updates, decisionClock });
    return requestId;
  }

  // A result or expiry update waits while its owner and channel already have one in flight (RES-09).
  private queueUpdate(update: HeldUpdate): void {
    if (this.requestsStopped) return;
    if (this.slotBusy(executionPlaces[update.unit], update.channel, "update")) {
      // A held update's intents are already decided: neither reselected nor reclaimed again while they wait (X1).
      for (const key of update.keys) this.inFlightKeys.add(key);
      this.heldUpdates.push(update);
      return;
    }
    this.sendIntentUpdate(update.unit, update.channel, "update", update.updates, update.decisionClock, update.keys);
  }

  private flushHeldUpdates(): void {
    for (const update of this.heldUpdates.splice(0)) this.queueUpdate(update);
  }

  private abortAttempts(requests: readonly NotificationAbortRequest[], completedAttemptId: string | null = null): void {
    for (const request of requests) {
      if (request.attemptId === completedAttemptId) continue;
      const name = channelNames.find((candidate) => this.notificationOperations[candidate]?.attemptId === request.attemptId);
      if (name == null) continue; // The run result already settled.
      const channel = this.state.notificationChannels[name];
      if (channel.kind !== "stopping" || channel.attempt.attemptId !== request.attemptId)
        throw new Error("A1 abort request has no stopping channel");
      void this.notificationAdapter.abort(request, channel.stopByMonotonicMs, this.clock).catch(() => {});
    }
  }

  private runAttempt(attempt: NotificationAttempt): void {
    const previous = this.notificationOperations[attempt.channel];
    if (previous != null) throw new Error("notification channel already has an operation");
    // The executor catches a synchronous run throw; only adapter errors become failed terminals.
    const operation = new Promise<NotificationResult>((resolve) => {
      resolve(this.notificationAdapter.run(attempt, this.clock));
    }).catch((): NotificationResult => ({ kind: "failed", reason: "adapterError",
      attemptId: attempt.attemptId, intentId: attempt.intentId, channel: attempt.channel, completedAt: this.clock() }))
      .then((result) => {
        if (this.notificationOperations[attempt.channel]?.attemptId === attempt.attemptId)
          this.notificationOperations[attempt.channel] = null;
        try { this.notificationResult(result); }
        catch (error) {
          if (this.onNotificationDispatchFailure != null) this.onNotificationDispatchFailure(error);
          // An old shutdown waiter may still observe terminal; keep failures after return unhandled.
          else void Promise.reject(error);
        }
      });
    this.notificationOperations[attempt.channel] = { attemptId: attempt.attemptId, terminal: operation };
  }

  // Expired pending intents become expired in their owner; a running attempt on one stops with "expired".
  // The intents named by reservations still in transit (at most one per owner and channel).
  private reservedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const request of this.intentRequests.values()) if (request.reserved != null) keys.add(request.reserved);
    return keys;
  }

  private reclaimExpired(clock: ClockReading): void {
    const state = this.state;
    if (state.shutdown.finalizationAt != null || this.requestsStopped) return;
    const reserved = this.reservedKeys();
    const expired = runtimeUnits.flatMap((unit) => state.mirror[unit].pendingIntents).filter((intent) =>
      !this.inFlightKeys.has(intentKey(intent)) && !reserved.has(intentKey(intent)) && (clock.wallTimeMs >= intent.expiresAt
        || clock.monotonicMs >= (state.notificationDeadlines[intent.channel][intentKey(intent)]?.expiresAtMonotonicMs ?? Infinity)));
    if (expired.length === 0) return;
    this.stopExpired(expired, clock);
    const counts: Partial<Record<RuntimeUnitId, number>> = {};
    const groups = new Map<string, HeldUpdate & { updates: NotificationIntentUpdate[]; keys: string[] }>();
    for (const intent of expired) {
      const unit = runtimeUnits.find((candidate) => candidate === intent.unit);
      if (unit == null) continue;
      const group = groups.get(JSON.stringify([unit, intent.channel]))
        ?? { unit, channel: intent.channel, updates: [], decisionClock: clock, keys: [] };
      group.updates.push({ id: intent.id, attempts: intent.attempts, nextAttemptAt: intent.nextAttemptAt, disposition: "expired" });
      group.keys.push(intentKey(intent));
      groups.set(JSON.stringify([unit, intent.channel]), group);
      counts[unit] = (counts[unit] ?? 0) + 1;
    }
    for (const group of groups.values()) this.queueUpdate(group);
    for (const unit of runtimeUnits) if (counts[unit] != null)
      this.enqueueDiagnostic(completeDiagnostic({ level: "INFO", component: "runtime", reason: "notificationExpired",
        unit, count: counts[unit] }, clock, state.runId));
  }

  private stopExpired(expired: readonly NotificationIntent[], clock: ClockReading): void {
    const state = this.state;
    const channels = { ...state.notificationChannels };
    const aborts: NotificationAbortRequest[] = [];
    for (const name of channelNames) {
      const channel = channels[name];
      if (channel.kind === "running" && expired.some((intent) => sameIntent(intent, { ...channel.attempt, id: channel.attempt.intentId }))) {
        channels[name] = { kind: "stopping", attempt: channel.attempt, cause: "expired", stopByMonotonicMs: clock.monotonicMs + 1_000 };
        aborts.push({ attemptId: channel.attempt.attemptId, cause: "expired" });
      }
    }
    if (aborts.length === 0) return;
    this.current = { ...state, notificationChannels: channels };
    this.abortAttempts(aborts);
  }

  private selectDelivery(clock: ClockReading): void {
    const state = this.state;
    if (state.shutdown.stage !== "running") return;
    const ownerPending = runtimeUnits.flatMap((unit) => state.mirror[unit].pendingIntents);
    const before = this.deliveryState();
    if (ownerPending.length === 0 && before.channels.desktop.kind === "idle" && before.channels.sound.kind === "idle"
      && Object.keys(before.deadlines.desktop).length === 0 && Object.keys(before.deadlines.sound).length === 0
      && this.reservations.desktop == null && this.reservations.sound == null) return;
    const live = new Set(ownerPending.map(intentKey));
    const deadlines = { desktop: { ...before.deadlines.desktop }, sound: { ...before.deadlines.sound } };
    let changedDeadline = false;
    for (const channel of channelNames) {
      for (const key of Object.keys(deadlines[channel])) if (!live.has(key)) {
        delete deadlines[channel][key];
        changedDeadline = true;
      }
      for (const intent of ownerPending) if (intent.channel === channel) {
        const key = intentKey(intent);
        if (deadlines[channel][key] == null) {
          changedDeadline = true;
          deadlines[channel][key] = {
            retryAtMonotonicMs: clock.monotonicMs + Math.max(0, intent.nextAttemptAt - clock.wallTimeMs),
            expiresAtMonotonicMs: clock.monotonicMs + Math.max(0, intent.expiresAt - clock.wallTimeMs),
          };
        }
      }
    }
    if (Object.keys(deadlines.desktop).length + Object.keys(deadlines.sound).length > 384)
      throw new RangeError("notification deadline capacity exceeded");
    const selectedState = { ...before, deadlines: changedDeadline ? deadlines : before.deadlines };
    if (changedDeadline) this.current = { ...this.state, notificationDeadlines: deadlines };
    if (!this.state.notificationProbeComplete) return;
    const select = this.notificationCalls.selectNotificationAttempt;
    if (select == null) {
      if (before.intents.length !== 0) throw new Error("A7 selection is not linked");
      return;
    }
    const selection = select(selectedState, clock);
    for (const attempt of selection.attempts) {
      const intent = before.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      const updated = selection.state.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      const channel = selection.state.channels[attempt.channel];
      if (intent == null || clock.wallTimeMs >= intent.expiresAt || updated == null || updated.attempts <= intent.attempts
        || channel.kind !== "running" || channel.attempt.attemptId !== attempt.attemptId)
        throw new Error("A7 returned an uncorrelated attempt");
    }
    // Selection-time expiry joins the expiry updates.
    const reserved = this.reservedKeys();
    const expired = selection.state.intents.filter((intent) => intent.disposition === "expired" && !reserved.has(intentKey(intent))
      && before.intents.some((original) => sameIntent(original, intent) && original.disposition === "pending"));
    if (expired.length !== 0) {
      const originals = before.intents.filter((original) => expired.some((intent) => sameIntent(original, intent)));
      for (const intent of originals) this.queueUpdate({ unit: runtimeUnits.find((unit) => unit === intent.unit)!,
        channel: intent.channel, decisionClock: clock, keys: [intentKey(intent)],
        updates: [{ id: intent.id, attempts: intent.attempts, nextAttemptAt: intent.nextAttemptAt, disposition: "expired" }] });
    }
    const channels = { ...this.state.notificationChannels };
    let channelsChanged = false;
    for (const name of channelNames) {
      const attempt = selection.attempts.find((candidate) => candidate.channel === name);
      const reservation = this.reservations[name];
      if (attempt == null) {
        // The reserved intent is no longer selected (higher priority, cancellation, expiry): its late reply starts nothing.
        if (reservation != null) delete this.reservations[name];
        const chosen = selection.state.channels[name];
        if (chosen !== channels[name] && chosen.kind !== "running") { channels[name] = chosen; channelsChanged = true; }
        continue;
      }
      const key = JSON.stringify([attempt.unit, attempt.intentId]);
      if (reservation?.key === key) continue;
      if (reservation != null) delete this.reservations[name];
      const unit = runtimeUnits.find((candidate) => candidate === attempt.unit);
      const updated = selection.state.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      if (unit == null || updated == null || this.slotBusy(executionPlaces[unit], name, "reservation") || this.requestsStopped) continue;
      // The attempt count is adopted by the owner first; the adapter starts only on its adopted reply.
      const requestId = this.sendIntentUpdate(unit, name, "reservation", [{ id: updated.id, attempts: updated.attempts,
        nextAttemptAt: updated.nextAttemptAt, disposition: updated.disposition }], clock, [], key);
      this.reservations[name] = { requestId, attempt, unit, key };
    }
    if (channelsChanged) this.current = { ...this.state, notificationChannels: channels };
    this.abortAttempts(selection.abortRequests);
    for (const details of selection.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, this.state.runId));
  }

  private evaluateDelivery(clock: ClockReading): void {
    if (this.state.shutdown.finalizationAt != null) return;
    this.reclaimExpired(clock);
    this.selectDelivery(clock);
  }

  private intentUpdateDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "intentUpdateDone" }>): void {
    const request = this.intentRequests.get(reply.requestId);
    if (request == null || request.place !== place) return;
    this.intentRequests.delete(reply.requestId);
    for (const key of request.keys) this.inFlightKeys.delete(key);
    const clock = this.clock();
    const channels = this.state.notificationChannels;
    const changed = this.absorb(place, reply.output, null, clock);
    const reservation = this.reservations[request.channel];
    if (request.slot === "reservation" && reservation?.requestId === reply.requestId) {
      delete this.reservations[request.channel];
      const state = this.state;
      const intent = state.mirror[reservation.unit].pendingIntents.find((candidate) => candidate.id === reservation.attempt.intentId);
      const deadline = state.notificationDeadlines[request.channel][reservation.key];
      // Only an adopted, current, unexpired reservation starts: an invalidated one never calls the adapter.
      if (reply.adopted && state.shutdown.stage === "running" && state.notificationChannels[request.channel].kind === "idle"
        && intent != null && clock.wallTimeMs < intent.expiresAt && clock.monotonicMs < (deadline?.expiresAtMonotonicMs ?? Infinity)) {
        this.current = { ...state, notificationChannels: { ...state.notificationChannels,
          [request.channel]: { kind: "running", attempt: reservation.attempt } } };
        this.runAttempt(reservation.attempt);
      }
    }
    this.flushHeldUpdates();
    this.evaluateDelivery(clock);
    // E08: a reply that changed neither a unit nor a channel is not projected.
    if (changed || this.state.notificationChannels !== channels) this.project(reply.output.outcomes, reply.output.displayChanges, clock);
  }

  // A7 settles the channel at once; the intent's update goes to its owner with the result's completedAt.
  private notificationResult(result: NotificationResult): void {
    if (this.current == null || this.state.shutdown.finalizationAt != null) return;
    const clock = result.completedAt;
    if (!Number.isFinite(clock.wallTimeMs) || !Number.isFinite(clock.monotonicMs)) throw new RangeError("runtime clock must be finite");
    this.reclaimExpired(clock);
    const state = this.state;
    const channel = state.notificationChannels[result.channel];
    const attemptId = channel.kind === "running" || channel.kind === "stopping" ? channel.attempt.attemptId
      : channel.kind === "isolated" ? channel.attemptId : null;
    if (attemptId === result.attemptId && (channel.kind === "isolated"
      || (channel.kind === "running" || channel.kind === "stopping") && channel.attempt.intentId === result.intentId)) {
      const apply = this.notificationCalls.applyNotificationResult;
      if (apply == null) throw new Error("A7 result reducer is not linked");
      const before = this.deliveryState();
      const step = apply(before, result, result.completedAt);
      this.current = { ...state, notificationChannels: step.state.channels, notificationDeadlines: step.state.deadlines };
      if (channel.kind === "running" || channel.kind === "stopping") {
        const original = before.intents.find((intent) => sameIntent(intent, { ...channel.attempt, id: channel.attempt.intentId }));
        const candidate = step.state.intents.find((intent) => original != null && sameIntent(intent, original));
        const unit = runtimeUnits.find((value) => value === original?.unit);
        // Invalidated or late success cannot become delivered, even if a caller supplies it.
        const lateSuccess = candidate?.disposition === "delivered" && (channel.kind !== "running"
          || result.kind !== "delivered" || original?.disposition !== "pending"
          || clock.wallTimeMs >= (original?.expiresAt ?? -Infinity) || clock.monotonicMs >= channel.attempt.timeoutAtMonotonicMs);
        if (original != null && candidate != null && unit != null && !lateSuccess
          && (original.attempts !== candidate.attempts || original.nextAttemptAt !== candidate.nextAttemptAt
            || original.disposition !== candidate.disposition))
          this.queueUpdate({ unit, channel: result.channel, decisionClock: result.completedAt, keys: [intentKey(original)],
            updates: [{ id: candidate.id, attempts: candidate.attempts, nextAttemptAt: candidate.nextAttemptAt,
              disposition: candidate.disposition }] });
      }
      for (const details of step.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, state.runId));
      this.selectDelivery(clock);
    }
    this.project([], [], clock);
  }

  // ---- checkpoint (P3-C3A-WRITE-RIGHT) ----

  private persistence() {
    const { mirror } = this.state;
    return { "U-E": mirror["U-E"].persistence, "U-W": mirror["U-W"].persistence, "U-F": mirror["U-F"].persistence };
  }

  // P2-A10-AC12: at most one save or reconciliation in the whole process; the host calls it on every tick.
  // Resolves once the grant it issued (if any) has been answered.
  driveCheckpoint(): Promise<void> {
    const state = this.state;
    if (state.shutdown.stage !== "running" || this.failure != null) return Promise.resolve();
    const grant = this.checkpoint.next(this.persistence(), this.clock(), state.runId);
    if (grant == null) return Promise.resolve();
    this.post(executionPlaces[grant.unit], { kind: "checkpointGrant", grantId: grant.grantId, unit: grant.unit,
      mode: grant.mode, retryReason: grant.retryReason });
    return this.until(() => this.checkpoint.grant?.grantId !== grant.grantId);
  }

  private checkpointDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "checkpointDone" }>): void {
    const clock = this.clock();
    const previous = this.state.mirror[reply.unit].persistence;
    if (!this.checkpoint.done(reply.grantId, reply.unit, reply.result, reply.measurements, previous, clock)) return;
    if (this.late(place)) return;
    if (reply.measurements.length !== 0) this.onMeasurements(reply.measurements);
    this.ownerOutput(place, reply.output, null);
    // Declined (nothing to save at grant time): the next candidate needs no new tick.
    if (reply.result == null) void this.driveCheckpoint();
  }

  private async saveFinalGenerations(active: () => boolean, unfixed: ReadonlySet<RuntimeUnitId>): Promise<void> {
    const attempted = new Set<RuntimeUnitId>(unfixed);
    while (active()) {
      if (this.checkpoint.grant != null) {
        await this.until(() => this.checkpoint.grant == null, active);
        continue;
      }
      const state = this.state;
      const grant = this.checkpoint.next(this.persistence(), this.clock(), state.runId,
        { force: true, reconcile: false, excluded: attempted });
      if (grant == null) return;
      attempted.add(grant.unit);
      this.post(executionPlaces[grant.unit], { kind: "checkpointGrant", grantId: grant.grantId, unit: grant.unit,
        mode: grant.mode, retryReason: grant.retryReason });
    }
  }

  // ---- shutdown (spec §5.9) ----

  private finalizeDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "finalizeDone" }>): void {
    const finalization = this.finalization;
    if (finalization == null || finalization.closed || finalization.cutoff == null
      || reply.appliedThrough.wallTimeMs !== finalization.cutoff.wallTimeMs
      || reply.appliedThrough.monotonicMs !== finalization.cutoff.monotonicMs) {
      this.countLate();
      return;
    }
    finalization.fixed.add(place);
    this.absorb(place, reply.output, null, finalization.cutoff);
  }

  private quiet(): boolean {
    return this.inFlightInputs.size === 0 && this.intentRequests.size === 0 && this.checkpoint.grant == null
      && places.every((place) => !this.outstanding[place].deadline && !this.outstanding[place].shutdownInput);
  }

  // P3-C3A-AC09 sideEffectFinalization: (1) no more state-changing requests (2) every earlier reply applied (3) one cutoff
  // (4) each owner applies its deadlines up to the cutoff. The stage deadline bounds (2) and (4) together.
  private async finalizeOwners(active: () => boolean): Promise<void> {
    this.requestsStopped = true;
    this.heldUpdates.length = 0;
    const finalization: NonNullable<RuntimeCompositionRoot["finalization"]> = { cutoff: null, fixed: new Set(), closed: false };
    this.finalization = finalization;
    await this.until(() => this.quiet(), active);
    if (!active()) return;
    const cutoff = this.clock();
    finalization.cutoff = cutoff;
    // The publisher's own notification deadlines up to the cutoff: a running attempt on an expired intent stops.
    const state = this.state;
    this.stopExpired(runtimeUnits.flatMap((unit) => state.mirror[unit].pendingIntents).filter((intent) =>
      cutoff.wallTimeMs >= intent.expiresAt
      || cutoff.monotonicMs >= (state.notificationDeadlines[intent.channel][intentKey(intent)]?.expiresAtMonotonicMs ?? Infinity)), cutoff);
    for (const place of places) this.post(place, { kind: "finalize", cutoff }, cutoff);
    await this.until(() => places.every((place) => finalization.fixed.has(place)), active);
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

  async shutdownRuntime(acceptedThroughSequence: number,
    clock: ClockReading): Promise<ShutdownSummary> {
    if (this.state.shutdown.stage !== "running") throw new Error("shutdown already started");
    if (this.noticeTimer != null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    const failure: { error?: unknown } = {};
    this.onNotificationDispatchFailure = (error) => {
      if (!Object.hasOwn(failure, "error")) failure.error = error;
    };
    try {
      const requested = requestShutdown(this.state, clock, acceptedThroughSequence);
      this.current = requested.state;
      // Every reservation is void from the shutdown request on (P3-C3A-NOTIFY-ADOPT).
      this.reservations = {};
      this.abortAttempts(requested.abortRequests);
      for (const details of requested.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, this.state.runId));
      this.project([], [], clock);
      let effects: readonly RuntimeEffect[] = requested.effects;
      let batches = 0;
      let notificationAttempts = 0;
      let workers = 1;
      let summarySaved = false;
      let summary: ShutdownSummary | null = null;
      while (effects.length !== 0) {
        const effect: RuntimeEffect = effects[0];
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
                this.finalizeOwners(active),
              ]);
              break;
            }
            case "startFinalCheckpoints":
              await this.saveFinalGenerations(active, this.unfixedUnits());
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
        if (this.failure != null) throw new Error(`execution owner ${this.failure.place} stopped`, { cause: this.failure.cause });
        if (effect.kind === "finalizeNotificationDelivery") {
          notificationAttempts = channelNames.filter((channel) =>
            this.notificationOperations[channel] != null || this.state.notificationChannels[channel].kind === "isolated").length;
          if (this.finalization != null) this.finalization.closed = true;
        }
        const stats = this.mailbox.stats(this.clock().monotonicMs);
        const observedAt = this.clock();
        const cutoff = this.finalization?.cutoff ?? null;
        const observed = observeStage(this.state, { kind: "shutdownStageResult", stage,
          result: batchFailed ? { kind: "failed", reason: "operationFailed" } : result,
          pending: { mailboxPending: stats.pendingItems, mailboxInFlight: stats.inFlightItems,
            batches, notificationAttempts, unsavedUnits: 0, workers },
          clock: observedAt, droppedDiagnostics: this.diagnostics.droppedCounts() },
        cutoff?.wallTimeMs ?? null, [...this.unfixedUnits()]);
        this.current = observed.state;
        for (const details of observed.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, observedAt, this.state.runId));
        // spec §5.9 step 3: after the drain each owner gets its units' shutdown input.
        if (stage === "mailboxDrain") for (const place of places) {
          this.outstanding[place].shutdownInput = true;
          this.post(place, { kind: "shutdownInput" }, observedAt);
        }
        this.project([], [], observedAt);
        effects = observed.effects;
        summary = observed.summary ?? summary;
      }
      if (summary == null) throw new Error("shutdown did not produce a summary");
      // A1 owns both summaries. A failed final delivery is not reported as a successful persistence.
      const deadline = this.state.shutdown.deadlines.workerCloseMonotonicMs!;
      if (summarySaved && this.clock().monotonicMs < deadline) {
        const persisted = await within((active) => this.diagnostics.persistShutdownSummary(summary!, active), deadline, this.clock);
        if (Object.hasOwn(failure, "error")) throw failure.error;
        if (persisted.kind !== "completed")
          throw new Error("final shutdown summary could not be persisted");
      }
      return summary;
    } finally { this.onNotificationDispatchFailure = null; }
  }

  private unfixedUnits(): Set<RuntimeUnitId> {
    const finalization = this.finalization;
    if (finalization == null) return new Set();
    return new Set(runtimeUnits.filter((unit) => !finalization.fixed.has(executionPlaces[unit])));
  }
}

export { RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem, nodeDiagnosticFileSystem, sharedClock, snapshotInput };
export type { CompositionOptions, NotificationCalls, ProjectedStep, PublisherInput, ShutdownHooks };
