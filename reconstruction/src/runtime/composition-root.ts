import { randomUUID } from "node:crypto";
import { promises as fileSystem, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { CheckpointMeasurement, P2HostObservation } from "../../contracts/p2-eew-e01.types";
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
import type {
  ExecutionPlace, OwnerOutput, OwnerReply, OwnerRequest, OwnerUnitDelta, ParserEnvelope, WriteCounts,
} from "../../contracts/p3-execution-split.types";
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
import type { CheckpointFileSystem, CheckpointGrant, CodecMap } from "../checkpoint/checkpoint";
import { PersistentDiagnosticSink, projectParserDiagnostic } from "../checkpoint/persistent-diagnostic-sink";
import type { DiagnosticFileSystem } from "../checkpoint/persistent-diagnostic-sink";
import { Mailbox } from "../mailbox/mailbox";
import { abortNotificationAttempt, probeDesktopBackend, probeSoundBackend, resolveRepoPath, runNotificationAttempt } from "../notification-delivery/adapter";
import { applyNotificationResult, selectNotificationAttempt } from "../notification-delivery/notification-delivery";
import { eewUnit } from "../units/eew/eew-unit";
import { nankaiUnit } from "../units/nankai/nankai-unit";
import { seismicUnit } from "../units/seismic/seismic-unit";
import { volcanoUnit } from "../units/volcano/volcano-unit";
import { landslideUnit } from "../units/landslide/landslide-unit";
import { floodUnit } from "../units/flood/flood-unit";
import { briefingUnit } from "../units/briefing/briefing-unit";
import { tsunamiUnit } from "../units/tsunami/tsunami-unit";
import { weatherCurrentUnit } from "../units/weather-current/weather-current-unit";
import { weatherTimeseriesUnit } from "../units/weather-timeseries/weather-timeseries-unit";
import { dateValue, projectSnapshot } from "../view-projector/view-projector";
import { placeUnits } from "./owner-runtime";
import { completeDiagnostic } from "./runtime-diagnostic";
import {
  applyDeltas, confirmOutput, initialConfirmation, isEmptyOutput, lostConfirmation, observeStage, requestShutdown,
  validateProbe, verifyCoverage,
} from "./shared-runtime";
import type { MirrorUnit, PublisherState, RuntimeMirror } from "./shared-runtime";
import { executionPlaces, placeOfHeadType, runtimeUnits } from "./unit-coverage";

// A3 wiring of delivered units (A4 U-E, A5 U-W, A6 U-F, C5 U-T, C7 U-Q, C8 U-N, C9 U-V, C10 U-L, C11 U-R, C12 U-B). Notification (A7) links here on delivery.
// P3-UNIT-TABLE-001: the one table of unit functions. A unit lane adds its row here and nowhere else.
const linkedUnitTable = { "U-E": eewUnit, "U-W": weatherCurrentUnit, "U-F": weatherTimeseriesUnit, "U-T": tsunamiUnit,
  "U-Q": seismicUnit, "U-N": nankaiUnit, "U-V": volcanoUnit, "U-L": landslideUnit, "U-R": floodUnit,
  "U-B": briefingUnit } satisfies UnitTable;
// Durable rows give the codec, ephemeral rows none; the literal keeps each unit's own codec type (no `as`).
const codecOf = <K extends RuntimeUnitId>(module: UnitModule<K>) =>
  module.persistence.kind === "durable" ? module.persistence.codec : undefined;
const linkedUnitCodecs: CodecMap<RuntimeUnitStates> = {
  "U-E": codecOf(linkedUnitTable["U-E"]), "U-W": codecOf(linkedUnitTable["U-W"]), "U-F": codecOf(linkedUnitTable["U-F"]),
  "U-T": codecOf(linkedUnitTable["U-T"]), "U-Q": codecOf(linkedUnitTable["U-Q"]),
  "U-N": codecOf(linkedUnitTable["U-N"]), "U-V": codecOf(linkedUnitTable["U-V"]),
  "U-L": codecOf(linkedUnitTable["U-L"]), "U-R": codecOf(linkedUnitTable["U-R"]), "U-B": codecOf(linkedUnitTable["U-B"]),
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
  // P3-C4-AC04（E14・E15）の観測。測定の時（host の config.observe があるとき）だけ渡し、無ければ時刻取得・包み・記録を作らない。
  measure?: (observation: Extract<P2HostObservation, { kind: "checkpointGrant" | "writeCount" | "shutdownSummaryWrite" | "notificationAdoption" | "generationRaised" }>) => void;
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

// P3-C3B-RES-01: one fixed record per owner. sent: the send time of each unanswered request kind (checkpointGrant is
// left to the 10 s checkpoint monitor); replies may come out of order, so the oldest is the minimum of these slots.
type MonitorSlot = "deadline" | "shutdownInput" | "input" | "finalize" | `${NotificationChannel}:${IntentRequest["slot"]}`;
type OwnerJudgement = DisplayWorkerView["state"];
type OwnerMonitor = {
  sent: Record<MonitorSlot, number | null>;
  lastReplyAt: number | null;
  // The last tick's judgement, and the WARNs given since the owner was last healthy (RES-04).
  judged: OwnerJudgement;
  stalledReported: boolean;
  unresponsiveReported: boolean;
  stopped: boolean;
  // Items taken out of the mailbox when the owner stopped (counted as unprocessed by every later shutdown stage).
  removed: Readonly<{ pending: number; inFlight: number }>;
  // Inputs refused after the first one of the current episode; null outside an episode.
  refused: number | null;
};
const judgementRank: Readonly<Record<OwnerJudgement, number>> = { healthy: 0, stalled: 1, unresponsive: 2, stopped: 3 };
const RESPONSE_MS = 5_000;
const ownerMonitor = (): OwnerMonitor => ({
  sent: { deadline: null, shutdownInput: null, input: null, finalize: null, "desktop:reservation": null,
    "desktop:update": null, "sound:reservation": null, "sound:update": null },
  lastReplyAt: null, judged: "healthy", stalledReported: false, unresponsiveReported: false, stopped: false,
  removed: { pending: 0, inFlight: 0 }, refused: null,
});

// P3-C4-AC04 の測定だけが持つ記録。unsaved は unit ごとの E14 の起点（UnsavedMark）。grants は送った書込み権で、返信を受けたら
// 消す（停止の終わりに残れば未返信）。
type Measuring = Readonly<{
  observe: NonNullable<CompositionOptions["measure"]>;
  unsaved: Record<RuntimeUnitId, UnsavedMark>;
  grants: Map<string, Readonly<{ place: ExecutionPlace; sentMs: number; dirtyMs: number | null }>>;
  owners: Partial<Record<ExecutionPlace, WriteCounts>>; reservations: Map<string, ReservationSent>;
  publisher: WriteCounters;
}>;

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
  const tsunami = viewOf(state.mirror["U-T"]), earthquake = viewOf(state.mirror["U-Q"]), nankai = viewOf(state.mirror["U-N"]);
  const volcano = viewOf(state.mirror["U-V"]), landslide = viewOf(state.mirror["U-L"]), flood = viewOf(state.mirror["U-R"]);
  const briefing = viewOf(state.mirror["U-B"]);
  if (eew.unit !== "U-E" || weatherCurrent.unit !== "U-W" || weatherTimeseries.unit !== "U-F" || tsunami.unit !== "U-T"
    || earthquake.unit !== "U-Q" || nankai.unit !== "U-N" || volcano.unit !== "U-V"
    || landslide.unit !== "U-L" || flood.unit !== "U-R" || briefing.unit !== "U-B") throw new Error("mirror view of another unit");
  const admissionCounts: RuntimeAdmissionCounts = { "U-E": state.mirror["U-E"].admissionCounts,
    "U-W": state.mirror["U-W"].admissionCounts, "U-F": state.mirror["U-F"].admissionCounts, "U-T": state.mirror["U-T"].admissionCounts,
    "U-Q": state.mirror["U-Q"].admissionCounts, "U-N": state.mirror["U-N"].admissionCounts,
    "U-V": state.mirror["U-V"].admissionCounts, "U-L": state.mirror["U-L"].admissionCounts,
    "U-R": state.mirror["U-R"].admissionCounts, "U-B": state.mirror["U-B"].admissionCounts };
  return {
    // An invalid clock is passed through unrounded; A8 rejects it as snapshotClockInvalid.
    streamId, generatedAt: Number.isNaN(date.getTime()) ? String(nowMs) : date.toISOString(), nowMs, connection, worker,
    persistence: { "U-E": state.mirror["U-E"].persistence, "U-W": state.mirror["U-W"].persistence,
      "U-F": state.mirror["U-F"].persistence, "U-T": state.mirror["U-T"].persistence, "U-Q": state.mirror["U-Q"].persistence,
      "U-N": state.mirror["U-N"].persistence, "U-V": state.mirror["U-V"].persistence,
      "U-L": state.mirror["U-L"].persistence, "U-R": state.mirror["U-R"].persistence, "U-B": state.mirror["U-B"].persistence },
    recovery: state.restoration, confirmation: state.confirmation, admissionCounts,
    notificationChannels: state.notificationChannels, channelProbeComplete: state.notificationProbeComplete,
    eew, weatherCurrent, weatherTimeseries, tsunami, earthquake, nankai, volcano, landslide, flood, briefing, outcomes: step.outcomes, displayChanges: step.displayChanges,
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

// P3-C4-WRITE-COUNT（RES-05）: 区分ごとの固定 counter。write ごとの履歴は持たない。
type WriteCounters = { [K in keyof WriteCounts]: { count: number; bytes: number } };
function writeCounters(): WriteCounters {
  return { checkpoint: { count: 0, bytes: 0 }, tmp: { count: 0, bytes: 0 }, diagnosticLog: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } };
}
function countWrite(counters: WriteCounters, category: keyof WriteCounts, bytes: number, count = 1): void {
  counters[category].count += count;
  counters[category].bytes += bytes;
}

// 呼んだ時点で数える（失敗した write も、write 段の CheckpointMeasurement と同じく試みた byte で数える）。保存は一時 file に
// 書いて slot へ rename するので、一時 file 以外への write は checkpoint の直接の write。
function countedCheckpointFileSystem(fileSystem: CheckpointFileSystem, counters: WriteCounters): CheckpointFileSystem {
  return { ...fileSystem, async open(path) {
    const handle = await fileSystem.open(path);
    const category = path.endsWith(".tmp") ? "tmp" : "checkpoint";
    return { ...handle, write(data) { countWrite(counters, category, data.byteLength); return handle.write(data); } };
  } };
}

// 診断 sink の write: 追記は診断 log（回数は追記した行の数で jsonl の改行と照合できる）、置き換え（終了要約の一時 file）は tmp。
function countedDiagnosticFileSystem(fileSystem: DiagnosticFileSystem, counters: WriteCounters): DiagnosticFileSystem {
  return { ...fileSystem,
    appendFile(path, data) { countWrite(counters, "diagnosticLog", Buffer.byteLength(data), data.split("\n").length - 1); return fileSystem.appendFile(path, data); },
    writeFile(path, data) {
      countWrite(counters, path.endsWith(".tmp") ? "tmp" : "other", Buffer.byteLength(data));
      return fileSystem.writeFile(path, data);
    } };
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
  // An owner that stopped before startRuntime completed rejects it (P3-C3A-AC01); later stops are per owner (C3b AC02).
  private startFailure: { place: ExecutionPlace; cause: unknown } | null = null;
  private readonly monitors: Record<ExecutionPlace, OwnerMonitor> = {
    urgent: ownerMonitor(), weatherCurrent: ownerMonitor(), deferred: ownerMonitor() };
  // P3-C3B-FINALIZE-UNHEALTHY (A): owners unresponsive when side-effect finalization began; left out of (2) and (4).
  private readonly unhealthy = new Set<ExecutionPlace>();
  // P3-C3B-AC08: an input waiting for its unit's held expiry update to be sent first (at most one per place).
  // P3-UWR-AC04 の自分の保存中の留保もここに置く（新しい queue を作らない、P3-UWR-RES-02）。
  private readonly delayedInputs = new Map<ExecutionPlace, ParserEnvelope>();
  // P3-UWR-AC04: 非緊急の実行場所ごとの、保存で留保した入力を置いた時刻（注入時計の monotonic）。再保存へ切り替えても延ばさない。
  private readonly holdSince = new Map<ExecutionPlace, number>();
  // P3-UWR-HOLD-REPEAT=A: 留保が満了した時に出ていた自分の権。その checkpointDone を反映するまで、その owner の入力を再び留保しない。
  private readonly holdSpent = new Map<ExecutionPlace, readonly string[]>();
  // The latest owner reply already handed to the mailbox's worker-response record (once per tick, P3-C3B-AC07).
  private recordedResponse = -Infinity;
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
  private readonly measuring: Measuring | null;

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
    this.measuring = options.measure == null ? null : { observe: options.measure, unsaved: unsavedMarks(),
      grants: new Map(), owners: {}, publisher: writeCounters(), reservations: new Map() };
    const diagnosticFileSystem = options.diagnosticFileSystem ?? nodeDiagnosticFileSystem();
    this.diagnostics = new PersistentDiagnosticSink(config.diagnosticDirectory, this.measuring == null ? diagnosticFileSystem
      : countedDiagnosticFileSystem(diagnosticFileSystem, this.measuring.publisher), () => this.clock().wallTimeMs,
      options.reportFailure ?? ((event) => { process.stderr.write(`${JSON.stringify(event)}\n`); }), this.measuring == null ? undefined : (bytes) => this.measureSummary(bytes));
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
    const monitor = this.monitors[place];
    if (monitor.stopped) return;
    const slot = this.slotOf(request);
    if (slot != null) monitor.sent[slot] = clock.monotonicMs;
    this.sendRequest(place, { ...request, clock, sharedMs: this.sharedNow() });
  }

  private slotOf(request: OwnerRequestBody): MonitorSlot | null {
    switch (request.kind) {
      case "deadline": case "shutdownInput": case "input": case "finalize": return request.kind;
      case "intentUpdate": {
        const sent = this.intentRequests.get(request.requestId);
        return sent == null ? null : `${sent.channel}:${sent.slot}`;
      }
      case "restore": case "checkpointGrant": return null;
      default: { const unknown: never = request; throw new Error(`unknown owner request ${String(unknown)}`); }
    }
  }

  private stoppedUnit(unit: RuntimeUnitId): boolean { return this.monitors[executionPlaces[unit]].stopped; }

  // Stopped, or left out of the shutdown stages as unresponsive (P3-C3B-AC03).
  private shutdownExcluded(place: ExecutionPlace): boolean { return this.monitors[place].stopped || this.unhealthy.has(place); }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  // Resolves once condition holds after some reply (or at once); an abandoned wait is dropped at the next wake.
  private until(condition: () => boolean, active: () => boolean = () => true): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const failure = this.startFailure;
        if (failure != null) {
          this.waiters.delete(check);
          reject(new Error(`execution owner ${failure.place} stopped`, { cause: failure.cause }));
          return;
        }
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
    if (this.measuring != null) for (const unit of runtimeUnits) {
      const { currentGeneration, savedGeneration } = mirror[unit]!.persistence;
      if (currentGeneration > (savedGeneration ?? 0)) this.measuring.unsaved[unit].oldestMs = performance.now();
    }
    let state: PublisherState = {
      runId, mirror: { "U-E": mirror["U-E"]!, "U-W": mirror["U-W"]!, "U-F": mirror["U-F"]!, "U-T": mirror["U-T"]!,
        "U-Q": mirror["U-Q"]!, "U-N": mirror["U-N"]!, "U-V": mirror["U-V"]!, "U-L": mirror["U-L"]!, "U-R": mirror["U-R"]!,
        "U-B": mirror["U-B"]! },
      restoration: { "U-E": restoration["U-E"]!, "U-W": restoration["U-W"]!, "U-F": restoration["U-F"]!, "U-T": restoration["U-T"]!,
        "U-Q": restoration["U-Q"]!, "U-N": restoration["U-N"]!, "U-V": restoration["U-V"]!, "U-L": restoration["U-L"]!,
        "U-R": restoration["U-R"]!, "U-B": restoration["U-B"]! },
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
    const monitor = this.monitors[place];
    // A stopped owner's replies are not adopted (P3-C3B-AC02).
    if (monitor.stopped) return;
    monitor.lastReplyAt = this.clock().monotonicMs;
    switch (reply.kind) {
      case "restored":
        if (this.restored.has(place)) throw new Error("owner restored twice");
        this.restored.set(place, reply);
        break;
      case "inputDone":
        monitor.sent.input = null;
        this.inputDone(place, reply);
        break;
      case "deadlineDone":
        monitor.sent.deadline = null;
        this.outstanding[place].deadline = false;
        this.ownerOutput(place, reply.output, null);
        // P3-UWR-AC03: 反映 → 権の再評価 → 入力を送ってよいかの判定。
        this.reevaluate();
        this.sendDelayedInputs();
        break;
      case "intentUpdateDone": this.intentUpdateDone(place, reply); break;
      case "checkpointDone": this.checkpointDone(place, reply); break;
      case "shutdownInputDone":
        monitor.sent.shutdownInput = null;
        this.outstanding[place].shutdownInput = false;
        this.ownerOutput(place, reply.output, null);
        break;
      case "finalizeDone":
        monitor.sent.finalize = null;
        this.finalizeDone(place, reply);
        break;
      default: { const unknown: never = reply; throw new Error(`unknown owner reply ${String(unknown)}`); }
    }
    this.wake();
  }

  // P3-C3B-OWNER-STOP (A): an owner's error or unexpected exit stops that owner only. Its mailbox items, requests,
  // reservations and held updates go; its unit keeps the last view and gets no grant (a write right it holds is kept,
  // DEAD-WRITE-RIGHT A). Before startRuntime completed, the stop rejects startRuntime instead (P3-C3A-AC01).
  ownerFailed(place: ExecutionPlace, cause: unknown): void {
    if (this.current == null) {
      this.startFailure ??= { place, cause };
      this.wake();
      return;
    }
    const monitor = this.monitors[place];
    if (monitor.stopped) return;
    const clock = this.clock();
    this.endRefusals(place, clock);
    monitor.stopped = true;
    monitor.removed = this.mailbox.removePlace(place);
    this.inFlightInputs.delete(place);
    this.delayedInputs.delete(place);
    this.holdSince.delete(place);
    this.holdSpent.delete(place);
    this.outstanding[place] = { deadline: false, shutdownInput: false };
    for (const [requestId, request] of this.intentRequests) if (request.place === place) {
      this.intentRequests.delete(requestId);
      for (const key of request.keys) this.inFlightKeys.delete(key);
    }
    const units = placeUnits(place);
    for (const channel of channelNames) {
      const reservation = this.reservations[channel];
      if (reservation != null && units.includes(reservation.unit)) delete this.reservations[channel];
    }
    for (let index = this.heldUpdates.length - 1; index >= 0; index -= 1) if (units.includes(this.heldUpdates[index].unit)) {
      for (const key of this.heldUpdates[index].keys) this.inFlightKeys.delete(key);
      this.heldUpdates.splice(index, 1);
    }
    this.enqueueDiagnostic(completeDiagnostic({ level: "ERROR", component: `owner.${place}`, reason: "ownerStopped",
      count: monitor.removed.pending + monitor.removed.inFlight }, clock, this.state.runId));
    this.wake();
    this.evaluateDelivery(clock);
    this.project([], [], clock);
  }

  // P3-C3B-AC01 (spec:1190-1191): stalled when the oldest unanswered request is 5 s old; unresponsive when, with a
  // request unanswered, no reply came for 5 s. The per-tick deadline request is the idle owner's progress answer.
  private judge(monitor: OwnerMonitor, nowMonotonicMs: number): Readonly<{ stalledMs: number | null; unresponsiveMs: number | null }> {
    let oldest = Infinity;
    for (const sent of Object.values(monitor.sent)) if (sent != null && sent < oldest) oldest = sent;
    if (oldest === Infinity) return { stalledMs: null, unresponsiveMs: null };
    const stalledMs = nowMonotonicMs - oldest;
    const unresponsiveMs = nowMonotonicMs - Math.max(monitor.lastReplyAt ?? -Infinity, oldest);
    return { stalledMs: stalledMs >= RESPONSE_MS ? stalledMs : null, unresponsiveMs: unresponsiveMs >= RESPONSE_MS ? unresponsiveMs : null };
  }

  // P3-C3B-AC01 / WORKER-VIEW (A): the tick's judgement of the three owners and the mailbox as one worker view, worst
  // first (stopped > unresponsive > stalled > healthy). One WARN per state entry; nothing is judged after stop().
  monitorOwners(clock: ClockReading = this.clock()): DisplayWorkerView {
    if (this.state.shutdown.stage !== "running") return this.snapshotWorker;
    const now = clock.monotonicMs;
    let worst: OwnerJudgement = this.mailbox.isStalled(now) ? "stalled" : "healthy";
    for (const place of places) {
      const monitor = this.monitors[place];
      const { stalledMs, unresponsiveMs } = this.judge(monitor, now);
      const judged: OwnerJudgement = monitor.stopped ? "stopped"
        : unresponsiveMs != null ? "unresponsive" : stalledMs != null ? "stalled" : "healthy";
      if (!monitor.stopped) {
        const warn = (component: string, durationMs: number) => this.enqueueDiagnostic(completeDiagnostic({ level: "WARN",
          component, reason: "mailboxStalled", count: 1, durationMs }, clock, this.state.runId));
        if (stalledMs != null && !monitor.stalledReported) { monitor.stalledReported = true; warn(`owner.${place}`, stalledMs); }
        if (unresponsiveMs != null && !monitor.unresponsiveReported) {
          monitor.unresponsiveReported = true;
          warn(`owner.${place}.response`, unresponsiveMs);
        }
        if (judged === "healthy") {
          monitor.stalledReported = monitor.unresponsiveReported = false;
          this.endRefusals(place, clock);
        }
      }
      monitor.judged = judged;
      if (judgementRank[judged] > judgementRank[worst]) worst = judged;
    }
    const inWorst = places.filter((place) => this.monitors[place].judged === worst);
    let lastResponse: number | null = null;
    for (const place of inWorst.length === 0 ? places : inWorst) {
      const at = this.monitors[place].lastReplyAt;
      if (at != null && (lastResponse == null || at < lastResponse)) lastResponse = at;
    }
    return { state: worst, lastProgressAtMonotonicMs: this.mailbox.stats(now).lastProgressMonotonicMs, lastResponseAtMonotonicMs: lastResponse };
  }

  // P3-C3B-DEAD-PLACE-INPUT / HUNG-PLACE-INPUT (A): an input for a stopped or unresponsive owner is refused before the
  // mailbox, until the owner is healthy again. The first of an episode is one WARN with its inputId; later ones are
  // counted into one line at its end. From the shutdown request on, the draining mailbox refuses instead.
  refuseInput(inputId: string, headType: string, clock: ClockReading = this.clock()): boolean {
    if (this.state.shutdown.stage !== "running") return false;
    const place = placeOfHeadType(headType);
    const monitor = this.monitors[place];
    if (!monitor.stopped && monitor.judged !== "unresponsive" && (monitor.refused == null || monitor.judged === "healthy")) return false;
    if (monitor.refused != null) monitor.refused += 1;
    else {
      monitor.refused = 0;
      this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: this.refusalComponent(place), reason: "ownerStopped",
        inputId }, clock, this.state.runId));
    }
    return true;
  }

  private refusalComponent(place: ExecutionPlace): string {
    return this.monitors[place].stopped ? `owner.${place}` : `owner.${place}.response`;
  }

  // The end of a refusal episode (back to healthy, the owner stopping, or the shutdown request).
  private endRefusals(place: ExecutionPlace, clock: ClockReading): void {
    const monitor = this.monitors[place];
    if (monitor.refused != null && monitor.refused > 0)
      this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: this.refusalComponent(place), reason: "ownerStopped",
        count: monitor.refused }, clock, this.state.runId));
    monitor.refused = null;
  }

  // P3-C3A-AC09: replies from an owner that was not fixed before the finalization deadline (or was left out of it as
  // unresponsive, P3-C3B-FINALIZE-UNHEALTHY) are counted only.
  private late(place: ExecutionPlace): boolean {
    const { finalization } = this;
    if (!this.unhealthy.has(place) && (finalization == null || finalization.fixed.has(place)
      || !finalization.closed && !this.finalizationExpired())) return false;
    this.countLate();
    return true;
  }

  // The side-effect finalization stage's absolute limit has passed, possibly before its timer ran (P3-C3A-FINALIZE-TIMEOUT).
  private finalizationExpired(): boolean {
    const limit = this.state.shutdown.deadlines.sideEffectFinalizationMonotonicMs;
    return this.finalization != null && limit != null && this.clock().monotonicMs >= limit;
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
    if (this.measuring != null) reflectUnsaved(this.measuring, state.mirror, output.units);
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
    if (this.current == null) return;
    // After the drain stage nothing more goes to the owners: what is left stays counted as pending (Y1).
    const { stage } = this.state.shutdown;
    if (stage !== "running" && stage !== "mailboxDrain") return;
    for (;;) {
      const envelope = this.mailbox.takeNext(this.clock().monotonicMs);
      if (envelope == null) return;
      if (!isParser(envelope)) throw new Error("the mailbox holds parser items only");
      const place = placeOfHeadType(envelope.payload.item.headType);
      this.inFlightInputs.set(place, envelope);
      this.sendInput(place, envelope);
    }
  }

  // P3-C3B-INTENT-RECLAIM (A): the input's own units' expired intents are reclaimed before it, so a full intent capacity
  // of monotonic-expired notices does not block it. While that update is held behind its slot the input waits.
  // P3-UWR-AC04: 非緊急の owner は、自分の保存中もその入力を留保する（2 つの遅延は別に判定し、両方が消えたときだけ送る）。
  private sendInput(place: ExecutionPlace, envelope: ParserEnvelope): void {
    const clock = this.clock();
    this.reclaimExpired(clock, placeUnits(place));
    if (this.inputWaits(place, clock.monotonicMs)) this.delayedInputs.set(place, envelope);
    else this.post(place, { kind: "input", envelope });
  }

  // Only while inputs still go to the owners (the drain stage at the latest, Y1). 留保の満了も、ここで tick と owner の返信ごとに判定する。
  private sendDelayedInputs(clock: ClockReading = this.clock()): void {
    const { stage } = this.state.shutdown;
    if (stage !== "running" && stage !== "mailboxDrain") return;
    for (const [place, envelope] of this.delayedInputs)
      if (!this.inputWaits(place, clock.monotonicMs)) {
        this.delayedInputs.delete(place);
        this.post(place, { kind: "input", envelope });
      }
  }

  private inputWaits(place: ExecutionPlace, nowMs: number): boolean {
    const saving = this.ownSaveHold(place, nowMs);
    return this.heldUpdates.some((update) => executionPlaces[update.unit] === place) || saving;
  }

  // P3-UWR-AC04: 自分の実行場所の unit の権が出ている間だけ留保する（他 unit の権は見ない）。urgent と running の外では留保しない
  // （spec §7.5、P3-UWR-AC07）。上限は置いた時から 1,000 ms（P3-UWR-HOLD-LIMIT=A）。満了しても権は回収しない（P3-UWR-AC05）。
  private ownSaveHold(place: ExecutionPlace, nowMs: number): boolean {
    const own = place === "urgent" || this.state.shutdown.stage !== "running" ? []
      : placeUnits(place).flatMap((unit) => this.checkpoint.grantOf(unit)?.grantId ?? []);
    const spent = this.holdSpent.get(place);
    if (spent != null && spent.some((grantId) => own.includes(grantId))) return false;
    this.holdSpent.delete(place);
    if (own.length === 0) {
      this.holdSince.delete(place);
      return false;
    }
    const since = this.holdSince.get(place) ?? nowMs;
    if (nowMs - since < 1_000) {
      this.holdSince.set(place, since);
      return true;
    }
    this.holdSince.delete(place);
    this.holdSpent.set(place, own);
    return false;
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
    const reflectedAt = this.measuring == null ? null : performance.now(); // E14 の起点は反映の時点（通知の評価・射影の時間を含めない）
    const adopted = this.ownerOutput(place, reply.output, settlement.runId === state.runId ? settlement.inputSequence : null); if (!adopted && reconnected) this.project([], [], this.clock());
    this.onInputDone(reply); if (this.measuring != null && adopted && reflectedAt != null) observeGenerationRaised(this.measuring, settlement.runId, reply, reflectedAt);
    // P3-UWR-AC02・AC03: 処理を終えた owner の unit へ、次の入力を送る前に権を出す。
    this.reevaluate();
    this.sendDelayedInputs();
    this.pump();
  }

  // The 1 s tick: each owner applies its own due deadlines on its deadline request (P3-C3A-DEADLINES). A deadline still
  // unanswered is not sent again; the next tick sends the latest clock (P3-C3A-AC15).
  tick(clock: ClockReading = this.clock()): void {
    const state = this.state;
    // P2-A2-AC05 worker response before its predicate runs below: the latest reply of any owner, so the mailbox.worker
    // WARN means none answered for 5 s. Recorded once per tick, not per reply (AC07).
    let latest = -Infinity;
    for (const place of places) latest = Math.max(latest, this.monitors[place].lastReplyAt ?? -Infinity);
    // Never moved back: a response the mailbox already holds (recorded by another caller) is not overwritten by an older one.
    if (latest > this.recordedResponse) {
      this.recordedResponse = latest;
      if (latest > (this.mailbox.stats(clock.monotonicMs).lastWorkerResponseMonotonicMs ?? -Infinity)) this.mailbox.recordWorkerResponse(latest);
    }
    // P3-UWR-AC04: 満了した留保の入力は、同じ tick の期限要求より先に送る（owner は届いた順に適用する）。
    this.sendDelayedInputs(clock);
    if (!this.requestsStopped && state.shutdown.finalizationAt == null)
      for (const place of places) if (!this.monitors[place].stopped && !this.outstanding[place].deadline) {
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

  // A stopped owner's pending intents leave A7, except one whose attempt already runs: it ends by the adapter (AC02).
  private deliverableIntents(unit: RuntimeUnitId): readonly NotificationIntent[] {
    const { pendingIntents } = this.state.mirror[unit];
    if (!this.stoppedUnit(unit)) return pendingIntents;
    const channels = this.state.notificationChannels;
    return pendingIntents.filter((intent) => channelNames.some((name) => {
      const channel = channels[name];
      return (channel.kind === "running" || channel.kind === "stopping")
        && sameIntent(intent, { ...channel.attempt, id: channel.attempt.intentId });
    }));
  }

  private deliveryState(): NotificationDeliveryState {
    const state = this.state;
    return {
      intents: runtimeUnits.flatMap((unit) => this.deliverableIntents(unit).filter((intent) =>
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
    if (this.requestsStopped || this.stoppedUnit(update.unit)) return;
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

  private reclaimExpired(clock: ClockReading, units: readonly RuntimeUnitId[] = runtimeUnits): void {
    const state = this.state;
    if (state.shutdown.finalizationAt != null || this.requestsStopped) return;
    const reserved = this.reservedKeys();
    const expired = units.flatMap((unit) => this.stoppedUnit(unit) ? [] : state.mirror[unit].pendingIntents).filter((intent) =>
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
    const ownerPending = runtimeUnits.flatMap((unit) => this.deliverableIntents(unit));
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
    // P3-C5-AC14: pending の上限は unit ごとに 128（P2-A7-RES-01）なので、表は最大で runtimeUnits の数×128。
    if (Object.keys(deadlines.desktop).length + Object.keys(deadlines.sound).length > runtimeUnits.length * 128)
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
      this.measuring?.reservations.set(requestId, { channel: name, intentId: updated.id, unit, attempts: updated.attempts, createdAtWallMs: updated.createdAt,
        sentWallMs: clock.wallTimeMs, sentMs: performance.now() });
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
    this.monitors[place].sent[`${request.channel}:${request.slot}`] = null;
    this.intentRequests.delete(reply.requestId);
    for (const key of request.keys) this.inFlightKeys.delete(key);
    // P3-C4-AC13(5): 予約の返信を受けた時刻（測定の時だけ）。adapter の呼出しの開始は下の runAttempt の直前。
    const adoption = request.slot === "reservation" ? this.measuring?.reservations.get(reply.requestId) : undefined;
    const replyReceivedMs = adoption == null ? null : performance.now();
    let attemptStartedMs: number | null = null;
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
        if (adoption != null) attemptStartedMs = performance.now();
        this.runAttempt(reservation.attempt);
      }
    }
    if (this.measuring != null && adoption != null && replyReceivedMs != null) {
      this.measuring.reservations.delete(reply.requestId);
      this.measuring.observe({ kind: "notificationAdoption", runId: this.state.runId, channel: adoption.channel, intentId: adoption.intentId,
        unit: adoption.unit, attempts: adoption.attempts, createdAtWallMs: adoption.createdAtWallMs, reservationSentWallMs: adoption.sentWallMs,
        reservationSentMonotonicMs: adoption.sentMs, replyReceivedMonotonicMs: replyReceivedMs, adopted: reply.adopted, attemptStartedMonotonicMs: attemptStartedMs });
    }
    this.flushHeldUpdates();
    this.reevaluate(clock);
    this.sendDelayedInputs(clock);
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
      // An attempt of a stopped owner ends here: its result has no owner to go to (P3-C3B-AC02).
      const attempted = channel.kind === "isolated" ? undefined : runtimeUnits.find((value) => value === channel.attempt.unit);
      if (attempted != null && this.stoppedUnit(attempted))
        this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "notification", reason: "ownerStopped" }, clock, state.runId));
      this.selectDelivery(clock);
    }
    this.project([], [], clock);
  }

  // ---- checkpoint (P3-C3A-WRITE-RIGHT) ----

  private persistence() {
    const { mirror } = this.state;
    return { "U-E": mirror["U-E"].persistence, "U-W": mirror["U-W"].persistence, "U-F": mirror["U-F"].persistence,
      "U-T": mirror["U-T"].persistence, "U-Q": mirror["U-Q"].persistence, "U-N": mirror["U-N"].persistence,
      "U-V": mirror["U-V"].persistence, "U-L": mirror["U-L"].persistence, "U-R": mirror["U-R"].persistence,
      "U-B": mirror["U-B"].persistence };
  }

  // P2-A10-AC12・P3-UWR-AC01: unit ごとに保存か照合を最大 1 件。host の tick ごとと、owner の返信の反映ごと（P3-UWR-AC03）に呼ぶ。
  // この呼出しで出した権が全部返ったら解決する。
  driveCheckpoint(): Promise<void> {
    const grants = this.reevaluate();
    if (grants.length === 0) return Promise.resolve();
    return this.until(() => grants.every((grant) => this.checkpoint.grantOf(grant.unit)?.grantId !== grant.grantId));
  }

  // running の間だけ権を出す。停止した owner の unit（P3-C3B-AC02）と、送出済みで inputDone が未着の入力を持つ実行場所の unit
  // （P3-UWR-AC02。留保して未送出の入力は数えない）には出さない。出ている権の監視は呼出しのたびに回る。
  private reevaluate(clock: ClockReading = this.clock()): readonly CheckpointGrant[] {
    const state = this.state;
    if (state.shutdown.stage !== "running") return [];
    const busy = (place: ExecutionPlace) => this.monitors[place].stopped || this.inFlightInputs.has(place) && !this.delayedInputs.has(place);
    const grants = this.checkpoint.next(this.persistence(), clock, state.runId,
      { excluded: new Set(runtimeUnits.filter((unit) => busy(executionPlaces[unit]))) });
    for (const grant of grants) this.postGrant(grant);
    return grants;
  }

  // 送出時刻は post の前に取る（owner は別 thread で、post の直後に着手しうる）。
  private postGrant(grant: CheckpointGrant): void {
    if (this.measuring != null) {
      const mark = this.measuring.unsaved[grant.unit];
      this.measuring.grants.set(grant.grantId, { place: executionPlaces[grant.unit], sentMs: performance.now(), dirtyMs: mark.oldestMs });
      if (grant.mode === "save") Object.assign(mark, { sinceGrantMs: null, afterGrant: true });
    }
    this.post(executionPlaces[grant.unit], { kind: "checkpointGrant", grantId: grant.grantId, unit: grant.unit,
      mode: grant.mode, retryReason: grant.retryReason });
  }

  // E14（P3-C4-AC04(2)）: 返信を受けた時点で権 1 回の区間を 1 行出す。返信が来た owner の counter はその返信の値に替える。
  private measureGrant(measuring: Measuring, place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "checkpointDone" }>): void {
    const receivedMs = performance.now();
    const sent = measuring.grants.get(reply.grantId);
    measuring.grants.delete(reply.grantId);
    if (reply.writeCounts != null) measuring.owners[place] = reply.writeCounts;
    if (sent == null || reply.grantStartedMs == null) return;
    measuring.observe({ kind: "checkpointGrant", runId: this.state.runId, grantId: reply.grantId, unit: reply.unit,
      attemptIds: [...new Set(reply.measurements.map((measurement) => measurement.attemptId))], dirtyObservedMonotonicMs: sent.dirtyMs,
      grantSentMonotonicMs: sent.sentMs, ownerStartedMonotonicMs: reply.grantStartedMs, doneReceivedMonotonicMs: receivedMs,
      result: reply.result == null ? null : { kind: reply.result.kind, generation: reply.result.generation } });
  }

  // E15: 終了要約の書き手の記録を試行ごとに 1 行（publisher の tmp の照合に使う、P3-C4-AC05）。
  private measureSummary(bytes: number): void {
    this.measuring?.observe({ kind: "shutdownSummaryWrite", runId: this.state.runId, bytes });
  }

  // P3-C4-WRITE-COUNT: 停止の終わりに thread ごとの累積を 1 回だけ出す。owner は、送った権の返信が全部来て、最終保存の段が期限で
  // 打ち切られず、終了の段で exit を確かめた（worker close が完了した）ときだけ confirmed。停止済みの owner は confirmed にしない
  // （最後の write が counter にも測定記録にも出ていないことがある）。権を一度も受けていない owner の counter は 0。
  private observeWriteCounts(measuring: Measuring, finalSaveCut: boolean, ownersClosed: boolean): void {
    const runId = this.state.runId;
    const unanswered = new Set([...measuring.grants.values()].map((grant) => grant.place));
    for (const place of places) measuring.observe({ kind: "writeCount", runId, thread: place,
      confirmed: ownersClosed && !finalSaveCut && !this.monitors[place].stopped && !unanswered.has(place),
      counts: measuring.owners[place] ?? writeCounters() });
    measuring.observe({ kind: "writeCount", runId, thread: "publisher", confirmed: ownersClosed, counts: structuredClone(measuring.publisher) });
  }

  private checkpointDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "checkpointDone" }>): void {
    if (this.measuring != null) this.measureGrant(this.measuring, place, reply);
    const clock = this.clock();
    const previous = this.state.mirror[reply.unit].persistence;
    if (!this.checkpoint.done(reply.grantId, reply.unit, reply.result, reply.measurements, previous, clock)) return;
    if (this.late(place)) return;
    if (reply.measurements.length !== 0) this.onMeasurements(reply.measurements);
    this.ownerOutput(place, reply.output, null);
    // P3-UWR-AC03・AC06: 結果を問わず、反映の後に権を再評価する（保存中に上がった世代の unit へ次の権、辞退の後の次の候補）。
    this.reevaluate(clock);
    this.sendDelayedInputs(clock);
  }

  // Returns true when a write right is held by an owner treated as stopped: it is never released, so the stage ends at
  // once instead of waiting out its limit (P3-C3B-AC03). P3-UWR-AC07: 権の Map でも今の挙動を保つ（どれかの権を停止扱いの
  // owner が持てば段を終え、そうでなければ権が全部返ってから 1 つずつ渡す）。
  private async saveFinalGenerations(active: () => boolean, unfixed: ReadonlySet<RuntimeUnitId>): Promise<boolean> {
    const attempted = new Set<RuntimeUnitId>(unfixed);
    const heldByExcluded = () => this.checkpoint.grants.some((grant) => this.shutdownExcluded(executionPlaces[grant.unit]));
    while (active()) {
      if (this.checkpoint.grants.length !== 0) {
        if (heldByExcluded()) return true;
        await this.until(() => this.checkpoint.grants.length === 0 || heldByExcluded(), active);
        continue;
      }
      // An owner that stopped after its finalizeDone gets no grant: post() would not send it, and the right it then
      // seemed to hold would end the stage for every other unit. Its unsaved unit stays counted by its persistence.
      for (const unit of runtimeUnits) if (this.stoppedUnit(unit)) attempted.add(unit);
      const state = this.state;
      const [grant] = this.checkpoint.next(this.persistence(), this.clock(), state.runId,
        { force: true, reconcile: false, excluded: attempted, limit: 1 });
      if (grant == null) return false;
      attempted.add(grant.unit);
      this.postGrant(grant);
    }
    return false;
  }

  // ---- shutdown (spec §5.9) ----

  private finalizeDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "finalizeDone" }>): void {
    const finalization = this.finalization;
    if (finalization == null || finalization.closed || finalization.cutoff == null || this.finalizationExpired()
      || reply.appliedThrough.wallTimeMs !== finalization.cutoff.wallTimeMs
      || reply.appliedThrough.monotonicMs !== finalization.cutoff.monotonicMs) {
      this.countLate();
      return;
    }
    finalization.fixed.add(place);
    this.absorb(place, reply.output, null, finalization.cutoff);
  }

  // Owners treated as stopped are not waited for (P3-C3B-AC03).
  private quiet(): boolean {
    const live = (place: ExecutionPlace) => !this.shutdownExcluded(place);
    // A delayed input was never sent, so no reply will settle it; it stays in flight in the mailbox (remainingInputs).
    for (const place of this.inFlightInputs.keys()) if (live(place) && !this.delayedInputs.has(place)) return false;
    for (const request of this.intentRequests.values()) if (live(request.place)) return false;
    return this.checkpoint.grants.every((grant) => !live(executionPlaces[grant.unit]))
      && places.every((place) => !live(place) || !this.outstanding[place].deadline && !this.outstanding[place].shutdownInput);
  }

  // P3-C3A-AC09 sideEffectFinalization: (1) no more state-changing requests (2) every earlier reply applied (3) one cutoff
  // (4) each owner applies its deadlines up to the cutoff. The stage deadline bounds (2) and (4) together.
  private async finalizeOwners(active: () => boolean): Promise<void> {
    this.requestsStopped = true;
    this.heldUpdates.length = 0;
    const finalization: NonNullable<RuntimeCompositionRoot["finalization"]> = { cutoff: null, fixed: new Set(), closed: false };
    this.finalization = finalization;
    await this.until(() => this.quiet(), active);
    this.delayedInputs.clear();
    this.holdSince.clear();
    if (!active()) return;
    const cutoff = this.clock();
    finalization.cutoff = cutoff;
    // The publisher's own notification deadlines up to the cutoff: a running attempt on an expired intent stops.
    const state = this.state;
    this.stopExpired(runtimeUnits.flatMap((unit) => state.mirror[unit].pendingIntents).filter((intent) =>
      cutoff.wallTimeMs >= intent.expiresAt
      || cutoff.monotonicMs >= (state.notificationDeadlines[intent.channel][intentKey(intent)]?.expiresAtMonotonicMs ?? Infinity)), cutoff);
    for (const place of places) if (!this.shutdownExcluded(place)) this.post(place, { kind: "finalize", cutoff }, cutoff);
    await this.until(() => places.every((place) => this.shutdownExcluded(place) || finalization.fixed.has(place)), active);
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

  // P3-C3B-AC03: the worker close stage's limit in real time (performance.now()), fixed when the stage starts. The
  // summary saves, the owners' termination and the host's clean-up all end by it, even if the injected clock stands.
  private workerCloseBy: number | null = null;
  get workerCloseByRealMs(): number | null { return this.workerCloseBy; }

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
      for (const place of places) this.endRefusals(place, clock);
      for (const details of requested.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, this.state.runId));
      this.project([], [], clock);
      let effects: readonly RuntimeEffect[] = requested.effects;
      let batches = 0;
      let notificationAttempts = 0;
      let workers = 1;
      let summarySaved = false;
      let finalSaveCut = false;
      let summary: ShutdownSummary | null = null;
      while (effects.length !== 0) {
        const effect: RuntimeEffect = effects[0];
        const stage = this.state.shutdown.stage;
        if (stage === "running" || stage === "completed") throw new Error("unexpected shutdown effect");
        if (effect.kind === "stopInputAndDrainMailbox") {
          this.mailbox.beginDrain(this.clock().monotonicMs);
          // P3-UWR-AC07: tick の無い drain で段の期限まで残らないよう、自分の保存中の留保をここで解く（期限切れの更新による遅延は残す）。
          this.sendDelayedInputs();
        }
        let batchFailed = false;
        let rightHeldByStopped = false;
        if (effect.kind === "closeRuntimeWorkers")
          this.workerCloseBy = performance.now() + Math.max(0, effect.deadlineMonotonicMs - this.clock().monotonicMs);
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
              rightHeldByStopped = await this.saveFinalGenerations(active, this.unfixedUnits());
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
        if (effect.kind === "startFinalCheckpoints" && result.kind === "deadlineExceeded") finalSaveCut = true;
        if (effect.kind === "finalizeNotificationDelivery") {
          notificationAttempts = channelNames.filter((channel) =>
            this.notificationOperations[channel] != null || this.state.notificationChannels[channel].kind === "isolated").length;
          if (this.finalization != null) this.finalization.closed = true;
        }
        const stats = this.mailbox.stats(this.clock().monotonicMs);
        const observedAt = this.clock();
        const cutoff = this.finalization?.cutoff ?? null;
        // Inputs a stopped owner left are unprocessed in every later stage; in the drain stage they fail it (code 3).
        let removedPending = 0, removedInFlight = 0;
        for (const place of places) {
          removedPending += this.monitors[place].removed.pending;
          removedInFlight += this.monitors[place].removed.inFlight;
        }
        const ownerStopped = rightHeldByStopped || stage === "mailboxDrain" && removedPending + removedInFlight > 0;
        const observed = observeStage(this.state, { kind: "shutdownStageResult", stage,
          result: batchFailed ? { kind: "failed", reason: "operationFailed" }
            : ownerStopped ? { kind: "failed", reason: "ownerStopped" } : result,
          pending: { mailboxPending: stats.pendingItems + removedPending, mailboxInFlight: stats.inFlightItems + removedInFlight,
            batches, notificationAttempts, unsavedUnits: 0, workers },
          clock: observedAt, droppedDiagnostics: this.diagnostics.droppedCounts() },
        cutoff?.wallTimeMs ?? null, [...this.unfixedUnits()]);
        this.current = observed.state;
        for (const details of observed.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, observedAt, this.state.runId));
        // spec §5.9 step 3: after the drain each owner gets its units' shutdown input. An owner unresponsive at this
        // clock is left out of the stages from here on (P3-C3B-FINALIZE-UNHEALTHY A).
        if (stage === "mailboxDrain") {
          for (const place of places) if (!this.monitors[place].stopped
            && this.judge(this.monitors[place], observedAt.monotonicMs).unresponsiveMs != null) this.unhealthy.add(place);
          for (const place of places) if (!this.shutdownExcluded(place)) {
            this.outstanding[place].shutdownInput = true;
            this.post(place, { kind: "shutdownInput" }, observedAt);
          }
        }
        this.project([], [], observedAt);
        effects = observed.effects;
        summary = observed.summary ?? summary;
      }
      if (summary == null) throw new Error("shutdown did not produce a summary");
      // A1 owns both summaries. A failed final delivery is not reported as a successful persistence. 期限切れは段の結果に揃える（実時間の期限と within の timer の境目で判定が割れないように。P3-C3B-AC03）。
      const deadline = this.state.shutdown.deadlines.workerCloseMonotonicMs!;
      const closeBy = this.workerCloseBy ?? -Infinity;
      if (summarySaved && this.state.shutdown.stageResults.workerClose?.result.kind !== "deadlineExceeded" && this.clock().monotonicMs < deadline && performance.now() < closeBy) {
        // Bounded by the stage's real-time limit, not a fresh window of the injected clock.
        const real = () => ({ wallTimeMs: this.clock().wallTimeMs, monotonicMs: performance.now() });
        const persisted = await within((active) => this.diagnostics.persistShutdownSummary(summary!, active), closeBy, real);
        if (Object.hasOwn(failure, "error")) throw failure.error;
        // P3-C3B-AC09: 期限切れでは期限内に返す約束を優先し、未保存を返り値に明示する（悲観側）。期限の時点で始まっていた
        // rename は後から終わりうるので、disk には 1 回目か 2 回目の完全な要約のどちらかが残る。
        if (persisted.kind === "deadlineExceeded")
          summary = { ...summary, code: summary.code === 0 ? 4 : summary.code,
            reasons: [...summary.reasons, "workerClose:summaryNotPersisted"] };
        else if (persisted.kind !== "completed")
          throw new Error("final shutdown summary could not be persisted");
      }
      if (this.measuring != null) this.observeWriteCounts(this.measuring, finalSaveCut, workers === 0);
      return summary;
    } finally { this.onNotificationDispatchFailure = null; }
  }

  private unfixedUnits(): Set<RuntimeUnitId> {
    const finalization = this.finalization;
    if (finalization == null) return new Set();
    return new Set(runtimeUnits.filter((unit) => !finalization.fixed.has(executionPlaces[unit])));
  }
}

// P3-C4-AC13(5): 送った予約（返信を受けたら消す。返信の来ない予約は停止した owner の分だけで、件数は予約の枠で限られる）。
type ReservationSent = Readonly<{ channel: NotificationChannel; intentId: string; unit: RuntimeUnitId; attempts: number; createdAtWallMs: number;
  sentWallMs: number; sentMs: number }>;

// E14 の起点。世代ごとの履歴は持たない（保存の失敗が続いても増えない）。oldestMs は最古の未保存の世代を publisher が反映した時刻、
// sinceGrantMs は最後の保存の権の後で最初に世代が上がった時刻。権の保存が一部の世代だけを確定したとき、残った最古の世代は権の後に
// 上がったものなので sinceGrantMs を起点にする（その世代の反映以前の時刻なので、待ちを短く見せない側の値）。
type UnsavedMark = { oldestMs: number | null; sinceGrantMs: number | null; afterGrant: boolean };
function unsavedMarks(): Record<RuntimeUnitId, UnsavedMark> {
  const mark = (): UnsavedMark => ({ oldestMs: null, sinceGrantMs: null, afterGrant: false });
  return { "U-E": mark(), "U-W": mark(), "U-F": mark(), "U-T": mark(), "U-Q": mark(), "U-N": mark(), "U-V": mark(), "U-L": mark(), "U-R": mark(),
    "U-B": mark() };
}

// P3-C4-AC13(3)②（工程2c）: 反映した inputDone の inputGenerations にある unit ごとに 1 行（E14 の束の起点）。at は反映（absorb）の前に
// 取った時刻。反映が拒否された返信（遅れた返信など）では呼ばない。入力の前の期限回収だけで上がった世代は owner が inputGenerations に
// 入れないので、ここでも出ない。
function observeGenerationRaised(measuring: Measuring, runId: string, reply: InputDone, at: number): void {
  for (const unit of runtimeUnits) {
    const generation = reply.inputGenerations?.[unit];
    if (generation != null) measuring.observe({ kind: "generationRaised", runId, inputId: reply.settlement.inputId, unit, generation, monotonicMs: at,
      ownerMonotonicMs: reply.generationRaisedMs });
  }
}

// E14 の起点（Measuring の unsaved）を返信 1 件の差分で更新する（測定の時だけ、unit ごとに定数の手間）。
function reflectUnsaved(measuring: Measuring, mirror: RuntimeMirror, deltas: readonly OwnerUnitDelta[]): void {
  const at = performance.now();
  for (const { unit, persistence } of deltas) {
    const mark = measuring.unsaved[unit];
    const before = mirror[unit].persistence;
    if (persistence.currentGeneration > before.currentGeneration) {
      mark.oldestMs ??= at;
      if (mark.afterGrant) mark.sinceGrantMs ??= at;
    }
    const saved = persistence.savedGeneration ?? 0;
    if (saved > (before.savedGeneration ?? 0)) {
      mark.oldestMs = persistence.currentGeneration > saved ? mark.sinceGrantMs ?? at : null;
      Object.assign(mark, { sinceGrantMs: null, afterGrant: false });
    }
  }
}

export { RuntimeCompositionRoot, countedCheckpointFileSystem, linkedRuntimeCalls, linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem,
  nodeDiagnosticFileSystem, sharedClock, snapshotInput, writeCounters };
export type { CompositionOptions, NotificationCalls, ProjectedStep, PublisherInput, ShutdownHooks, WriteCounters };
