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
  RuntimeDisplayChange,
  RuntimeInput,
  RuntimePublishedOutcome,
  NotificationResult,
  RuntimeEffect,
  RuntimeUnitStates,
  RuntimeUnitId,
  ShutdownPendingCounts,
  ShutdownStageResult,
  ShutdownSummary, WallBasis, DiagnosticReason,
} from "../../contracts/p2-shared-runtime.types";
import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types"; import type { WeatherTimeseriesDetailRequest, WeatherTimeseriesDetailResponse } from "../../contracts/p2-weather-timeseries-unit.types";
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
import type { SoundBackend } from "../notification-delivery/adapter";
import { ATTEMPT_TIMEOUT_MS, applyNotificationResult, selectNotificationAttempt } from "../notification-delivery/notification-delivery";
import { eewUnit } from "../units/eew/eew-unit";
import { nankaiUnit } from "../units/nankai/nankai-unit";
import { seismicUnit } from "../units/seismic/seismic-unit";
import { volcanoUnit } from "../units/volcano/volcano-unit";
import { landslideUnit } from "../units/landslide/landslide-unit";
import { floodUnit } from "../units/flood/flood-unit";
import { briefingUnit } from "../units/briefing/briefing-unit";
import { localBulletinsUnit } from "../units/local-bulletins/local-bulletins-unit";
import { typhoonUnit } from "../units/typhoon/typhoon-unit";
import { tsunamiUnit } from "../units/tsunami/tsunami-unit";
import { weatherCurrentUnit } from "../units/weather-current/weather-current-unit";
import { weatherTimeseriesUnit } from "../units/weather-timeseries/weather-timeseries-unit";
import { dateValue, projectSnapshot } from "../view-projector/view-projector";
import { placeUnits } from "./owner-runtime";
import { completeDiagnostic } from "./runtime-diagnostic";
import {
  applyDeltas, confirmOutput, initialConfirmation, isEmptyOutput, lostConfirmation, observeStage, requestShutdown,
  suspectFreshness, validateProbe, verifyCoverage,
} from "./shared-runtime";
import type { MirrorUnit, PublisherState, RuntimeMirror } from "./shared-runtime";
import { classifyHeadType, executionPlaces, placeOfHeadType, runtimeUnits } from "./unit-coverage";
import { familyFor } from "../decode-material/decode-material";
import { RECOVERABLE_UNITS, WALK_ORDER, bodiesFor, buildDigest, recoveryPlan, recoveryStart, walkDiagnostics, widerStart, windowOf } from "../recovery/recovery";
import type { Restored, WalkStart } from "../recovery/recovery";
import { EewWindow, FreshnessLedger } from "../recovery/watch";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { BodyResult, EewWindowCard, ListHead, PollResult, PoolPosition, RecoveryProgressUnit, RecoveryUnsatisfiedReason, UnitWalk,
  UnitWalkResult } from "../../contracts/p3-recovery.types";
import type { Operation } from "../../contracts/p1-parser-boundary.types";
import { ingestXmlData } from "../ingress/ingress";

// A3 wiring of delivered units (A4 U-E, A5 U-W, A6 U-F, C5 U-T, C7 U-Q, C8 U-N, C9 U-V, C10 U-L, C11 U-R, C12 U-B, C13 U-M, C14 U-Y). Notification (A7) links here on delivery.
// P3-UNIT-TABLE-001: the one table of unit functions. A unit lane adds its row here and nowhere else.
const linkedUnitTable = { "U-E": eewUnit, "U-W": weatherCurrentUnit, "U-F": weatherTimeseriesUnit, "U-T": tsunamiUnit,
  "U-Q": seismicUnit, "U-N": nankaiUnit, "U-V": volcanoUnit, "U-L": landslideUnit, "U-R": floodUnit,
  "U-B": briefingUnit, "U-M": localBulletinsUnit, "U-Y": typhoonUnit } satisfies UnitTable;
// Durable rows give the codec, ephemeral rows none; the literal keeps each unit's own codec type (no `as`).
const codecOf = <K extends RuntimeUnitId>(module: UnitModule<K>) =>
  module.persistence.kind === "durable" ? module.persistence.codec : undefined;
const linkedUnitCodecs: CodecMap<RuntimeUnitStates> = {
  "U-E": codecOf(linkedUnitTable["U-E"]), "U-W": codecOf(linkedUnitTable["U-W"]), "U-F": codecOf(linkedUnitTable["U-F"]),
  "U-T": codecOf(linkedUnitTable["U-T"]), "U-Q": codecOf(linkedUnitTable["U-Q"]),
  "U-N": codecOf(linkedUnitTable["U-N"]), "U-V": codecOf(linkedUnitTable["U-V"]),
  "U-L": codecOf(linkedUnitTable["U-L"]), "U-R": codecOf(linkedUnitTable["U-R"]), "U-B": codecOf(linkedUnitTable["U-B"]), "U-M": codecOf(linkedUnitTable["U-M"]),
  "U-Y": codecOf(linkedUnitTable["U-Y"]),
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
type OwnerRequestBody = OwnerRequest extends infer R ? R extends unknown ? Omit<R, "clock" | "sharedMs" | "basis"> : never : never;

type CompositionOptions = Readonly<{
  // P3-C3A: the one way a request reaches an owner. The host posts it to the owner's thread.
  send: (place: ExecutionPlace, request: OwnerRequest) => void;
  clock?: () => ClockReading; wallBasis?: (at: ClockReading) => WallBasis; // P3-CK-AC02: 締切の印を反映した通知用の根拠（省略は "verified"）
  contentBasis?: (at: ClockReading) => WallBasis; // P3-EF-AC01: unit の期限へ運ぶ生の確かめの状態（省略は "verified"）
  // performance.timeOrigin + performance.now(), the real clock every thread shares (P3-C3A-CLOCK).
  sharedNow?: () => number;
  diagnosticFileSystem?: DiagnosticFileSystem;
  mailbox?: Mailbox;
  notificationAdapter?: Readonly<{
    run: (attempt: NotificationAttempt, clock: () => ClockReading, soundBackend?: SoundBackend) => Promise<NotificationResult>;
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

type PublisherInput = Extract<RuntimeInput, { kind: "connectionLost" | "coverageVerified" | "freshnessSuspected" | "notificationProbeCompleted" }>;
type ProjectedStep = Readonly<{ state: PublisherState; outcomes: readonly RuntimePublishedOutcome[];
  displayChanges: readonly RuntimeDisplayChange[] }>;

// A reserved attempt (P3-C3A-NOTIFY-ADOPT): the selected attempt waits for its owner to adopt the attempt count.
// P3-NL-AC07 (1): 採用の返信の後は waiting（採った世代 G と待ち始めの monotonic）を持ち、保存の ack か保存の障害まで adapter を呼ばない。
// replyReceivedMs は測定の時だけの返信の時刻（AC07 (8)）。
type Reservation = Readonly<{ requestId: string; attempt: NotificationAttempt; unit: RuntimeUnitId; key: string;
  waiting?: Readonly<{ generation: number; sinceMs: number; replyReceivedMs: number | null }> }>;
// One owner intentUpdate in flight: per owner and channel one reservation and one other update (P3-C3A-RES-09).
// keys: intents whose result is decided and in transit (out of selection and expiry). reserved: the intent a reservation
// names; it stays selectable, but no expiry update may overtake the owner's adoption with a stale attempt count.
type IntentRequest = Readonly<{ place: ExecutionPlace; channel: NotificationChannel; slot: "reservation" | "update";
  keys: readonly string[]; reserved: string | null }>;
type HeldUpdate = Readonly<{ unit: RuntimeUnitId; channel: NotificationChannel; updates: readonly NotificationIntentUpdate[];
  decisionClock: ClockReading; keys: readonly string[] }>;

// P3-C3B-RES-01: one fixed record per owner. sent: the send time of each unanswered request kind (checkpointGrant is
// left to the 10 s checkpoint monitor); replies may come out of order, so the oldest is the minimum of these slots.
type MonitorSlot = "deadline" | "shutdownInput" | "input" | "finalize" | "detail" | `${NotificationChannel}:${IntentRequest["slot"]}`;
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
  sent: { deadline: null, shutdownInput: null, input: null, finalize: null, detail: null, "desktop:reservation": null,
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
// owner へ送る intent の更新（P3-NL-AC06 (1)）。lossReason は終端にする更新にだけ付ける。
const updateOf = (intent: NotificationIntent, lossReason: NotificationIntentUpdate["lossReason"] = null): NotificationIntentUpdate => ({
  id: intent.id, attempts: intent.attempts, nextAttemptAt: intent.nextAttemptAt, disposition: intent.disposition,
  lastAttempt: intent.lastAttempt, replayed: intent.replayed, expiresAt: intent.expiresAt, lossReason });

function viewOf(unit: MirrorUnit) { return unit.view; }

// The one A1 state -> A8 input mapping; connection/worker come from the caller.
function snapshotInput(step: ProjectedStep, streamId: string, nowMs: number,
  connection: DisplayConnectionView, worker: DisplayWorkerView,
  recovery: Readonly<{ digest: ReturnType<typeof buildDigest> | null; eewUnverified: EewWindowCard | null; progress?: readonly RecoveryProgressUnit[] | null }>
    = { digest: null, eewUnverified: null }): SnapshotProjectionInput {
  const { state } = step;
  const date = new Date(nowMs);
  const eew = viewOf(state.mirror["U-E"]), weatherCurrent = viewOf(state.mirror["U-W"]), weatherTimeseries = viewOf(state.mirror["U-F"]);
  const tsunami = viewOf(state.mirror["U-T"]), earthquake = viewOf(state.mirror["U-Q"]), nankai = viewOf(state.mirror["U-N"]);
  const volcano = viewOf(state.mirror["U-V"]), landslide = viewOf(state.mirror["U-L"]), flood = viewOf(state.mirror["U-R"]);
  const briefing = viewOf(state.mirror["U-B"]), localBulletins = viewOf(state.mirror["U-M"]), typhoon = viewOf(state.mirror["U-Y"]);
  if (eew.unit !== "U-E" || weatherCurrent.unit !== "U-W" || weatherTimeseries.unit !== "U-F" || tsunami.unit !== "U-T"
    || earthquake.unit !== "U-Q" || nankai.unit !== "U-N" || volcano.unit !== "U-V"
    || landslide.unit !== "U-L" || flood.unit !== "U-R" || briefing.unit !== "U-B"
    || localBulletins.unit !== "U-M" || typhoon.unit !== "U-Y") throw new Error("mirror view of another unit");
  return {
    // An invalid clock is passed through unrounded; A8 rejects it as snapshotClockInvalid.
    streamId, generatedAt: Number.isNaN(date.getTime()) ? String(nowMs) : date.toISOString(), nowMs, connection, worker,
    persistence: { "U-E": state.mirror["U-E"].persistence, "U-W": state.mirror["U-W"].persistence,
      "U-F": state.mirror["U-F"].persistence, "U-T": state.mirror["U-T"].persistence, "U-Q": state.mirror["U-Q"].persistence,
      "U-N": state.mirror["U-N"].persistence, "U-V": state.mirror["U-V"].persistence,
      "U-L": state.mirror["U-L"].persistence, "U-R": state.mirror["U-R"].persistence, "U-B": state.mirror["U-B"].persistence, "U-M": state.mirror["U-M"].persistence,
      "U-Y": state.mirror["U-Y"].persistence },
    recovery: { restoration: state.restoration, digest: recovery.digest?.digest ?? null, eewUnverified: recovery.eewUnverified, progress: recovery.progress ?? null },
    recoveryDigestBytes: recovery.digest?.utf8Bytes ?? 0, confirmation: state.confirmation,
    notificationChannels: state.notificationChannels, channelProbeComplete: state.notificationProbeComplete,
    eew, weatherCurrent, weatherTimeseries, tsunami, earthquake, nankai, volcano, landslide, flood, briefing, localBulletins, typhoon, outcomes: step.outcomes, displayChanges: step.displayChanges,
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
  // P3-NL-D-SOUND-BACKEND=B: run の中だけの音の backend の位置（保存しない）。probe で鳴った backend から始める。
  private readonly soundBackend: SoundBackend = { index: 0 };
  private readonly onMeasurements: (measurements: readonly CheckpointMeasurement[]) => void;
  private readonly onInputDone: (reply: InputDone) => void;
  private current: PublisherState | null = null;
  private runId: string | null = null;
  // An owner that stopped before startRuntime completed rejects it (P3-C3A-AC01); later stops are per owner (C3b AC02).
  private startFailure: { place: ExecutionPlace; cause: unknown } | null = null;
  private readonly monitors: Record<ExecutionPlace, OwnerMonitor> = {
    urgent: ownerMonitor(), seismic: ownerMonitor(), weatherCurrent: ownerMonitor(), deferred: ownerMonitor() };
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
    urgent: { deadline: false, shutdownInput: false }, seismic: { deadline: false, shutdownInput: false },
    weatherCurrent: { deadline: false, shutdownInput: false }, deferred: { deadline: false, shutdownInput: false } };
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
  // P3-NL-AC07 (7): 保存の ack を待つ予約の最短の締切の timer（noticeTimer とは別の 1 本。project が noticeTimer を毎回外すので共用しない）。
  private ackTimer: NodeJS.Timeout | null = null;
  private lastDiagnosticTick = -Infinity;
  private readonly measuring: Measuring | null;

  constructor(configInput: AppConfig, codecs: CodecMap<RuntimeUnitStates>, options: CompositionOptions) {
    const config = validateAppConfig(configInput);
    this.sendRequest = options.send;
    this.clock = options.clock ?? systemClock; this.wallBasis = options.wallBasis ?? (() => "verified"); this.contentBasis = options.contentBasis ?? (() => "verified");
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

  get lastDisconnectedAt(): number | null { return this.disconnectedAt; } get lastReceivedWallMs(): number | null { return this.lastFrameWallMs; } // P3-DC2-AC04: host の status() だけが読む

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
      if ((await probeSoundBackend(path, this.clock, this.soundBackend)).kind === "delivered") sound = { kind: "idle" };
    } catch { /* A failed probe leaves the sound channel unavailable. */ }
    finally { if (directory != null) await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); }
    return { desktop, sound };
  }

  private post(place: ExecutionPlace, request: OwnerRequestBody, clock = this.clock()): void {
    const monitor = this.monitors[place];
    if (monitor.stopped) return;
    const slot = this.slotOf(request);
    if (slot != null) monitor.sent[slot] = clock.monotonicMs;
    this.sendRequest(place, { ...request, clock, sharedMs: this.sharedNow(), basis: this.contentBasis(clock) });
  }

  private slotOf(request: OwnerRequestBody): MonitorSlot | null {
    switch (request.kind) {
      case "deadline": case "shutdownInput": case "input": case "finalize": case "detail": return request.kind;
      case "intentUpdate": {
        const sent = this.intentRequests.get(request.requestId);
        return sent == null ? null : `${sent.channel}:${sent.slot}`;
      }
      case "restore": case "checkpointGrant": case "recovery": return null;
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
    this.startedWallMs = clock.wallTimeMs;
    for (const place of places) this.post(place, { kind: "restore", runId }, clock);
    await this.until(() => places.every((place) => this.restored.has(place)));
    const mirror: Partial<Record<RuntimeUnitId, MirrorUnit>> = {};
    const restoration: Partial<Record<RuntimeUnitId, PublisherState["restoration"][RuntimeUnitId]>> = {};
    for (const place of places) for (const unit of this.restored.get(place)!.units) {
      mirror[unit.unit] = { persistence: unit.persistence, view: unit.view,
        pendingIntents: unit.pendingIntents };
      restoration[unit.unit] = unit.restoration; this.checkpoint.boundaries.restarted(unit.unit, unit.restoration.kind, unit.inputBoundary); if (!unit.saves) this.checkpoint.stopSaving(unit.unit);
    }
    if (runtimeUnits.some((unit) => mirror[unit] == null || restoration[unit] == null)) throw new Error("an owner did not restore every unit");
    if (this.measuring != null) for (const unit of runtimeUnits) {
      const { currentGeneration, savedGeneration } = mirror[unit]!.persistence;
      if (currentGeneration > (savedGeneration ?? 0)) this.measuring.unsaved[unit].oldestMs = performance.now();
    }
    let state: PublisherState = {
      runId, mirror: { "U-E": mirror["U-E"]!, "U-W": mirror["U-W"]!, "U-F": mirror["U-F"]!, "U-T": mirror["U-T"]!,
        "U-Q": mirror["U-Q"]!, "U-N": mirror["U-N"]!, "U-V": mirror["U-V"]!, "U-L": mirror["U-L"]!, "U-R": mirror["U-R"]!,
        "U-B": mirror["U-B"]!, "U-M": mirror["U-M"]!, "U-Y": mirror["U-Y"]! },
      restoration: { "U-E": restoration["U-E"]!, "U-W": restoration["U-W"]!, "U-F": restoration["U-F"]!, "U-T": restoration["U-T"]!,
        "U-Q": restoration["U-Q"]!, "U-N": restoration["U-N"]!, "U-V": restoration["U-V"]!, "U-L": restoration["U-L"]!,
        "U-R": restoration["U-R"]!, "U-B": restoration["U-B"]!, "U-M": restoration["U-M"]!, "U-Y": restoration["U-Y"]! },
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
    this.current = state; for (const unit of runtimeUnits) for (const intent of state.mirror[unit].pendingIntents) this.restoredKeys.add(intentKey(intent)); // P3-CK-AC03 (1)
    this.streamId = randomUUID();
    this.evaluateDelivery(clock);
    this.project(outcomes, displayChanges, clock);
  }

  // The one way a publisher input (not from an owner) changes the publisher state.
  dispatch(input: PublisherInput): void {
    const state = this.state;
    switch (input.kind) {
      case "connectionLost": {
        if (!Number.isSafeInteger(input.acceptedThroughSequence) || input.acceptedThroughSequence < -1)
          throw new RangeError("invalid disconnect sequence");
        this.current = { ...state, confirmation: lostConfirmation(state.confirmation, this.units, input.acceptedThroughSequence) };
        this.disconnectedAt = input.clock.wallTimeMs;
        this.lostThroughSequence = input.acceptedThroughSequence; this.checkpoint.boundaries.disconnected(input.acceptedThroughSequence);
        this.recoveryLost();
        break;
      }
      case "coverageVerified":
      case "freshnessSuspected": {
        const confirmation = input.kind === "coverageVerified" ? verifyCoverage(state.confirmation, this.units, state.runId, input)
          : suspectFreshness(state.confirmation, this.units, state.runId, input);
        if (confirmation !== state.confirmation) this.current = { ...state, confirmation };
        break;
      }
      case "notificationProbeCompleted": {
        if (state.notificationProbeComplete) break;
        validateProbe(input.channels);
        this.current = { ...state, notificationChannels: input.channels, notificationProbeComplete: true };
        const missing = channelNames.filter((name) => input.channels[name].kind === "unavailable").length;
        if (missing > 0) this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "notification-delivery",
          reason: "notificationAttemptFailed", count: missing }, input.clock, state.runId));
        this.evaluateDelivery(input.clock);
        break;
      }
      default: input satisfies never;
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
      case "intentUpdateDone": this.intentUpdateDone(place, reply); break; case "detailDone": this.detailDone(place, reply); break;
      case "recoveryDone": {
        // P3-REC-AC05: 返信の output（採用の mirror・負の証拠・診断）を反映してから、待っている取り直しへ渡す。
        this.ownerOutput(place, reply.output, null);
        const waiting = this.recoveryReplies.get(reply.recoveryId);
        this.recoveryReplies.delete(reply.recoveryId);
        waiting?.done(reply);
        break;
      }
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
    this.sendDetail(); this.wake();
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
    monitor.stopped = true; if (place === "deferred") this.failDetails();
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
    this.recoveryOwnerStopped(units);
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

  // P3-C3B-AC01 / WORKER-VIEW (A): the tick's judgement of the owners and the mailbox as one worker view, worst
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
    // P3-REC-AC02 (1): host が断った入力（穴 b）は取り直しのきっかけ（停止した owner の unit は requestRecovery が外す）。
    this.recoveryRefused(headType);
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
    // P3-REC-AC09 (1)(2): unit×operation ごとの最後の負の証拠の入力番号（absorb ごとに O(証拠)）。
    if (evidenceSequence != null) for (const evidence of output.confirmationEvidence)
      if (evidence.source !== "acceptedReport") for (const scope of evidence.scopes) this.noteNegative(scope.unit, scope.operation, evidenceSequence);
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

  // P3-UWR-AC04: 自分の実行場所の unit の権が出ている間だけ留保する（他 unit の権は見ない）。urgent・seismic と running の外では留保しない
  // （spec §7.5、P3-UWR-AC07。seismic は震度速報を U-Q の保存の後ろで遅らせないため、P3-SP-D-SAVE-HOLD=A）。上限は置いた時から 1,000 ms（P3-UWR-HOLD-LIMIT=A）。満了しても権は回収しない（P3-UWR-AC05）。
  private ownSaveHold(place: ExecutionPlace, nowMs: number): boolean {
    const own = place === "urgent" || place === "seismic" || this.state.shutdown.stage !== "running" ? []
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
    this.inFlightInputs.delete(place); this.checkpoint.boundaries.completed(settlement.inputSequence);
    const state = this.state;
    this.settledSequence = Math.max(this.settledSequence, settlement.inputSequence);
    // P3-REC-AC05・RES-01: 取り直しの本文の終わり（枠を返す）。取り直しの本文は繋がり直しの印にも確認の証拠にもしない（output は空か WARN だけ）。
    const body = settlement.runId === state.runId ? this.bodies.get(settlement.inputSequence) : undefined;
    if (body != null) {
      this.endBody(settlement.inputSequence, body);
      this.ownerOutput(place, reply.output, null);
      this.onInputDone(reply);
      this.reevaluate();
      this.sendDelayedInputs();
      this.pump();
      return;
    }
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
    this.watchRecovery(clock);
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
      this.connectionView(state), worker, { digest: this.recoveryDigest, eewUnverified: this.eewWindow?.card() ?? null, progress: this.progressView }), this.projection);
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
  // P3-REC-AC14 (1): data の frame も札の終わりになる（start の無い WS。切れていない間は札を動かさない）。
  recordInput(wallTimeMs: number): void { this.lastInputAt = wallTimeMs; this.eewWindow?.connected(wallTimeMs, this.clock().monotonicMs); }

  // P3-C2-AC06: a well-formed start on the current WS ends reconnecting without waiting for data; confirmation state stays.
  // P3-REC-AC14 (1)・AC13 (1): start の frame の wall が札の終わりの正本（inputDone の reconnected は処理の完了の時刻で遅い）。H41 の周期を許す。
  recordConnected(firstFrameWallMs: number): void {
    // P3-REC-AC02 (1): 切れた後の繋がり直し（穴 c）は取り直しのきっかけ。起動の最初の接続は起動の辿りが覆う。
    const reconnected = this.disconnectedAt != null && !this.socketStarted;
    this.lostThroughSequence = null;
    this.socketStarted = true;
    const now = this.clock().monotonicMs;
    this.eewWindow?.connected(firstFrameWallMs, now);
    // P3-REC-AC09 (4): U-E の確認の 10 分は繋がりから数える（切断で外す）。
    if (this.eewWindow != null) this.eewConfirm = { sinceMs: now, epoch: this.state.confirmation.epoch, afterSequence: this.currentSequence() };
    if (reconnected || this.firstConnectWanted) this.requestRecovery(RECOVERABLE_UNITS, null);
    this.firstConnectWanted = false;
  }

  private connectionView(state: PublisherState): DisplayConnectionView {
    return { state: state.shutdown.stage !== "running" ? "stopped" : this.lostThroughSequence == null ? "connected" : "reconnecting",
      disconnectedAt: this.disconnectedAt, lastInputAt: this.lastInputAt };
  }

  // ---- notification (A7 selection over the mirror; P3-C3A-NOTIFY-ADOPT) ----

  // A stopped owner's pending intents leave A7, except one whose attempt already runs: it ends by the adapter (AC02).
  private deliverableIntents(unit: RuntimeUnitId): readonly NotificationIntent[] {
    const { pendingIntents } = this.state.mirror[unit];
    return this.stoppedUnit(unit) ? pendingIntents.filter((intent) => this.attempting(intent)) : pendingIntents;
  }

  // channel で running か stopping の試行の intent（停止した owner の intent と、時計の保留の外、P3-CK-AC03 (2)）。
  private attempting(intent: NotificationIntent): boolean {
    const channel = this.state.notificationChannels[intent.channel];
    return (channel.kind === "running" || channel.kind === "stopping") && sameIntent(intent, { ...channel.attempt, id: channel.attempt.intentId });
  }

  private deliveryState(basis: WallBasis): NotificationDeliveryState {
    const state = this.state;
    return {
      intents: runtimeUnits.flatMap((unit) => this.deliverableIntents(unit).filter((intent) =>
        !this.inFlightKeys.has(intentKey(intent)) && !this.held(intent, basis))),
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
      resolve(this.notificationAdapter.run(attempt, this.clock, this.soundBackend));
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

  // P3-CK-AC03 (2)(3): 保留中の復元由来の intent は wall でも表でも回収せず、"unverified" で鳴らさず失効させる。stopping は停止の前の
  // 1 回で、"verified" でない間に残るものだけを失効させる。理由は停止の前の held で分ける（stopExpired が試行を止めると attempting が変わる）。
  private reclaimExpired(clock: ClockReading, units: readonly RuntimeUnitId[] = runtimeUnits, stopping = false): void {
    const state = this.state;
    if (state.shutdown.finalizationAt != null || this.requestsStopped) return;
    const reserved = this.reservedKeys();
    const basis = this.heldBasis(clock), clockExpired = stopping ? basis !== "verified" : basis === "unverified";
    const expired = units.flatMap((unit) => this.stoppedUnit(unit) ? [] : state.mirror[unit].pendingIntents).filter((intent) =>
      !this.inFlightKeys.has(intentKey(intent)) && !reserved.has(intentKey(intent)) && (this.held(intent, basis) ? clockExpired
        : !stopping && (clock.wallTimeMs >= intent.expiresAt
        || clock.monotonicMs >= (state.notificationDeadlines[intent.channel][intentKey(intent)]?.expiresAtMonotonicMs ?? Infinity))));
    if (expired.length === 0) return;
    const counts: Record<"notificationExpired" | "notificationExpiredClockUnverified", Partial<Record<NotificationIntent["unit"], number>>> = {
      notificationExpired: {}, notificationExpiredClockUnverified: {} };
    // P3-NL-AC06 (1): 送る expired の更新に診断と同じ理由の lossReason を付ける（理由は停止の前の held で分ける）。
    const reasons = new Map<NotificationIntent, keyof typeof counts>();
    for (const intent of expired) {
      const reason = this.held(intent, basis) ? "notificationExpiredClockUnverified" : "notificationExpired";
      reasons.set(intent, reason);
      const byUnit = counts[reason]; byUnit[intent.unit] = (byUnit[intent.unit] ?? 0) + 1;
    }
    this.stopExpired(expired, clock);
    const groups = new Map<string, HeldUpdate & { updates: NotificationIntentUpdate[]; keys: string[] }>();
    for (const intent of expired) {
      const unit = runtimeUnits.find((candidate) => candidate === intent.unit);
      if (unit == null) continue;
      const group = groups.get(JSON.stringify([unit, intent.channel]))
        ?? { unit, channel: intent.channel, updates: [], decisionClock: clock, keys: [] };
      group.updates.push(updateOf({ ...intent, disposition: "expired" }, reasons.get(intent)));
      group.keys.push(intentKey(intent));
      groups.set(JSON.stringify([unit, intent.channel]), group);
    }
    for (const group of groups.values()) this.queueUpdate(group);
    for (const reason of ["notificationExpired", "notificationExpiredClockUnverified"] as const) for (const unit of runtimeUnits) {
      const count = counts[reason][unit];
      if (count != null) this.enqueueDiagnostic(completeDiagnostic({ level: "INFO", component: "runtime", reason, unit, count }, clock, state.runId));
    }
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
    const basis = this.heldBasis(clock), deliverable = runtimeUnits.flatMap((unit) => this.deliverableIntents(unit)), live = new Set(deliverable.map(intentKey));
    // P3-CK-AC03 (1)(2): pending でなくなった intent の印を外す。保留中の復元由来の intent には表の行を作らず、選択に渡さない。
    for (const key of this.restoredKeys) if (!live.has(key)) this.restoredKeys.delete(key);
    const ownerPending = deliverable.filter((intent) => !this.held(intent, basis)), before = this.deliveryState(basis);
    if (ownerPending.length === 0 && before.channels.desktop.kind === "idle" && before.channels.sound.kind === "idle"
      && Object.keys(before.deadlines.desktop).length === 0 && Object.keys(before.deadlines.sound).length === 0
      && this.reservations.desktop == null && this.reservations.sound == null) return;
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
        updates: [updateOf({ ...intent, disposition: "expired" }, "notificationExpired")] });
    }
    const channels = { ...this.state.notificationChannels };
    let channelsChanged = false;
    for (const name of channelNames) {
      const attempt = selection.attempts.find((candidate) => candidate.channel === name);
      const reservation = this.reservations[name];
      if (attempt == null) {
        // The reserved intent is no longer selected (higher priority, cancellation, expiry): its late reply starts nothing.
        // P3-NL-AC07 (5): 採用済みで ack を待つ予約は、その intent が外れたとき（置換・取消・期限・保留）だけ捨て、その場で lastAttempt を
        // failed に戻す（Q-NL-PRECHECK-2 (1)(a)）。上位群・別の intent の選択は下の attempt のある側で捨てる。
        if (reservation != null && (reservation.waiting == null || !before.intents.some((intent) => intentKey(intent) === reservation.key))) {
          delete this.reservations[name];
          this.dropWaiting(name, reservation, clock);
        }
        const chosen = selection.state.channels[name];
        if (chosen !== channels[name] && chosen.kind !== "running") { channels[name] = chosen; channelsChanged = true; }
        continue;
      }
      const key = JSON.stringify([attempt.unit, attempt.intentId]);
      if (reservation?.key === key) continue;
      if (reservation != null) { delete this.reservations[name]; this.dropWaiting(name, reservation, clock); }
      const unit = runtimeUnits.find((candidate) => candidate === attempt.unit);
      const updated = selection.state.intents.find((candidate) => sameIntent(candidate, { ...attempt, id: attempt.intentId }));
      if (unit == null || updated == null || this.slotBusy(executionPlaces[unit], name, "reservation") || this.requestsStopped) continue;
      // The attempt count is adopted by the owner first; the adapter starts only on its adopted reply.
      // P3-NL-AC06 (1): 予約は試行の開始（lastAttempt started）を owner に採らせる。
      const requestId = this.sendIntentUpdate(unit, name, "reservation", [updateOf({ ...updated, lastAttempt: "started" })], clock, [], key);
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
    // P3-NL-AC07 (5): 先に選び直しを確定し（別の intent が選ばれた予約は adapter を呼ばずに捨てる）、また選ばれた予約だけを解放する。
    this.selectDelivery(clock);
    this.releaseWaiting(clock);
  }

  // P3-NL-AC07 (2)(3)(7): 採用済みの予約は、その unit の保存が G に届いたか（平時）、保存の障害（失敗・結果不明・保存されない）か、
  // 待ち始めから U-E・U-T・critical は 1,000 ms（DLV-01）・ほかは 10,000 ms（DLV-02）を過ぎたら adapter を呼ぶ。残りの最短の締切に timer を
  // 1 本置く（予約は channel ごとに 1 件なので 2 件の比較）。判定は予約ごとに mirror との比較 1 回（P3-NL-AC16）。
  private releaseWaiting(clock: ClockReading): void {
    if (this.ackTimer != null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.state.shutdown.stage !== "running") return;
    let due = Infinity;
    for (const channel of channelNames) {
      const reservation = this.reservations[channel], waiting = reservation?.waiting;
      if (reservation == null || waiting == null) continue;
      const { unit, attempt } = reservation;
      const limit = waiting.sinceMs + (unit === "U-E" || unit === "U-T" || attempt.payload.level === "critical" ? 1_000 : 10_000);
      if (this.saveSettled(unit, waiting.generation, clock) || clock.monotonicMs >= limit) this.startReserved(channel, reservation, clock);
      else due = Math.min(due, limit);
    }
    if (due === Infinity) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      const now = this.clock();
      this.evaluateDelivery(now);
      this.project([], [], now);
    }, Math.min(Math.max(due - clock.monotonicMs, 0), 2 ** 31 - 1));
    this.ackTimer.unref();
  }

  // 平時の ack（savedGeneration が G 以上。回復も kind でなくこれで見る、AC07 (4)）か、通知の側から見た保存の障害（AC07 (3)(a)(b)）。
  // 保存されない unit（復元の saves が false・この run で保存しない・owner が断った世代）は、dirty なのに saveDue が false になる。
  private saveSettled(unit: RuntimeUnitId, generation: number, clock: ClockReading): boolean {
    const persistence = this.state.mirror[unit].persistence;
    return (persistence.savedGeneration ?? 0) >= generation || persistence.kind === "failed" || persistence.kind === "uncertain"
      || persistence.dirtySince != null && !this.checkpoint.saveDue(persistence, unit, clock, true);
  }

  // 予約の試行を始める。今の開始の条件（stage running・channel idle・期限の内・K9 の保留でない）を満たさなければ予約を捨てる（AC06 (5)）。
  private startReserved(channel: NotificationChannel, reservation: Reservation, clock: ClockReading): void {
    delete this.reservations[channel];
    const state = this.state;
    const intent = state.mirror[reservation.unit].pendingIntents.find((candidate) => intentKey(candidate) === reservation.key);
    const deadline = state.notificationDeadlines[channel][reservation.key];
    if (state.notificationChannels[channel].kind !== "idle" || intent == null || this.inFlightKeys.has(reservation.key)
      || clock.wallTimeMs >= intent.expiresAt || clock.monotonicMs >= (deadline?.expiresAtMonotonicMs ?? Infinity)
      || this.held(intent, this.heldBasis(clock))) {
      this.dropWaiting(channel, reservation, clock);
      return;
    }
    // P3-NL-AC06 (4): 試行の期限は adapter を実際に呼ぶ時に作り直す（保存の待ちで試行の時間を食わない）。
    const attempt = { ...reservation.attempt, timeoutAtMonotonicMs: Math.min(clock.monotonicMs + ATTEMPT_TIMEOUT_MS[channel],
      deadline?.expiresAtMonotonicMs ?? Infinity) };
    this.current = { ...state, notificationChannels: { ...state.notificationChannels, [channel]: { kind: "running", attempt } } };
    this.observeAdoption(reservation, this.measuring == null ? null : performance.now());
    this.runAttempt(attempt);
  }

  // adapter を呼ばずに捨てた採用済みの予約（上位群・別の intent の選択・置換・取消・期限・停止）。返信待ちの予約は返信の時に扱う。
  private dropWaiting(channel: NotificationChannel, reservation: Reservation, clock: ClockReading): void {
    if (reservation.waiting == null) return;
    this.observeAdoption(reservation, null);
    this.failReserved([reservation.unit], reservation.key, channel, clock);
  }

  // P3-C4-AC13(5)・P3-NL-AC07 (8): 予約の行は adapter を呼ぶ時か捨てる時に出す（attemptStarted－replyReceived が保存の待ち）。
  private observeAdoption(reservation: Reservation, attemptStartedMs: number | null): void {
    const adoption = this.measuring?.reservations.get(reservation.requestId);
    if (this.measuring == null || adoption == null) return;
    this.measuring.reservations.delete(reservation.requestId);
    this.measuring.observe({ kind: "notificationAdoption", runId: this.state.runId, channel: adoption.channel, intentId: adoption.intentId,
      unit: adoption.unit, attempts: adoption.attempts, createdAtWallMs: adoption.createdAtWallMs, reservationSentWallMs: adoption.sentWallMs,
      reservationSentMonotonicMs: adoption.sentMs, replyReceivedMonotonicMs: reservation.waiting?.replyReceivedMs ?? performance.now(), adopted: true,
      attemptStartedMonotonicMs: attemptStartedMs });
  }

  private intentUpdateDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "intentUpdateDone" }>): void {
    const request = this.intentRequests.get(reply.requestId);
    if (request == null || request.place !== place) return;
    this.monitors[place].sent[`${request.channel}:${request.slot}`] = null;
    this.intentRequests.delete(reply.requestId);
    for (const key of request.keys) this.inFlightKeys.delete(key);
    // P3-C4-AC13(5): 予約の返信を受けた時刻（測定の時だけ）。採用して待つ予約の行は adapter を呼ぶ時か捨てる時に出す（observeAdoption）。
    const adoption = request.slot === "reservation" ? this.measuring?.reservations.get(reply.requestId) : undefined;
    const replyReceivedMs = adoption == null ? null : performance.now();
    const clock = this.clock();
    const channels = this.state.notificationChannels;
    const changed = this.absorb(place, reply.output, null, clock);
    const reservation = this.reservations[request.channel];
    let waiting = false;
    if (request.slot === "reservation" && reservation?.requestId === reply.requestId && reply.adopted && this.state.shutdown.stage === "running") {
      // P3-NL-AC07 (1): adapter をすぐ呼ばず、返信を反映した後のその unit の世代 G と待ち始めを残す。開始の条件と ack は releaseWaiting が
      // この返信の評価（下の evaluateDelivery）から確かめる。
      this.reservations[request.channel] = { ...reservation, waiting: { generation: this.state.mirror[reservation.unit].persistence.currentGeneration,
        sinceMs: clock.monotonicMs, replyReceivedMs } };
      waiting = true;
    } else if (request.slot === "reservation") {
      if (reservation?.requestId === reply.requestId) delete this.reservations[request.channel];
      if (reply.adopted) this.dropReservation(request, clock);
    }
    if (this.measuring != null && adoption != null && replyReceivedMs != null && !waiting) {
      this.measuring.reservations.delete(reply.requestId);
      this.measuring.observe({ kind: "notificationAdoption", runId: this.state.runId, channel: adoption.channel, intentId: adoption.intentId,
        unit: adoption.unit, attempts: adoption.attempts, createdAtWallMs: adoption.createdAtWallMs, reservationSentWallMs: adoption.sentWallMs,
        reservationSentMonotonicMs: adoption.sentMs, replyReceivedMonotonicMs: replyReceivedMs, adopted: reply.adopted, attemptStartedMonotonicMs: null });
    }
    this.flushHeldUpdates();
    this.reevaluate(clock);
    this.sendDelayedInputs(clock);
    this.evaluateDelivery(clock);
    // E08: a reply that changed neither a unit nor a channel is not projected.
    if (changed || this.state.notificationChannels !== channels) this.project(reply.output.outcomes, reply.output.displayChanges, clock);
  }

  // P3-NL-AC06 (5)（発注 1 の口は Q-NL-PRECHECK (0)(b)）: 採用の返信の後に adapter を呼ばずに捨てた予約（現在の予約と合わない返信・停止の後）は、
  // 採られた lastAttempt started を failed に戻す更新を送る（送っていないと確定。無いと復元で通知したか不明になり鳴らない）。
  private dropReservation(request: IntentRequest, clock: ClockReading): void {
    if (request.reserved != null) this.failReserved(placeUnits(request.place), request.reserved, request.channel, clock);
  }

  // 期限（wall か monotonic）の外のものは reclaimExpired が expired で終えるので送らない（Q-NL-PRECHECK-2 (1)(a)）。結果の決まった更新が
  // もう出ている intent にも送らない。印の evidence は下げない（unit の規則）。
  private failReserved(units: readonly RuntimeUnitId[], key: string, channel: NotificationChannel, clock: ClockReading): void {
    if (this.inFlightKeys.has(key)) return;
    for (const unit of units) {
      const intent = this.state.mirror[unit].pendingIntents.find((item) => intentKey(item) === key);
      if (intent == null) continue;
      if (intent.lastAttempt === "started" && clock.wallTimeMs < intent.expiresAt
        && clock.monotonicMs < (this.state.notificationDeadlines[channel][key]?.expiresAtMonotonicMs ?? Infinity))
        this.queueUpdate({ unit, channel, decisionClock: clock, keys: [key], updates: [updateOf({ ...intent, lastAttempt: "failed" })] });
      return;
    }
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
      const before = this.deliveryState(this.heldBasis(clock));
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
        // A7 は通知したか不明の終端に notificationOutcomeUnknown の診断を添える（ほかの expired は結果の照合での失効）。
        const lossReason = candidate?.disposition !== "expired" ? null
          : step.diagnostics.some((item) => item.reason === "notificationOutcomeUnknown") ? "notificationOutcomeUnknown" : "notificationExpired";
        if (original != null && candidate != null && unit != null && !lateSuccess
          && (original.attempts !== candidate.attempts || original.nextAttemptAt !== candidate.nextAttemptAt
            || original.disposition !== candidate.disposition || original.lastAttempt !== candidate.lastAttempt
            || original.replayed !== candidate.replayed || original.expiresAt !== candidate.expiresAt))
          this.queueUpdate({ unit, channel: result.channel, decisionClock: result.completedAt, keys: [intentKey(original)],
            updates: [updateOf(candidate, lossReason)] });
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
      "U-B": mirror["U-B"].persistence, "U-M": mirror["U-M"].persistence,
      "U-Y": mirror["U-Y"].persistence };
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
      mode: grant.mode, retryReason: grant.retryReason, inputBoundary: grant.inputBoundary });
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
    // P3-NL-AC07 (3)(b): owner が断った保存（空の返信）でも、ack を待つ予約はすぐ判定し直す（次の tick を待たない）。
    if (!this.ownerOutput(place, reply.output, null) && channelNames.some((name) => this.reservations[name]?.waiting != null)) {
      this.evaluateDelivery(clock);
      this.project([], [], clock);
    }
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
    // 待ちの前に置く: 段が期限で終わっても、未確定の unit は最終保存の外になり、期限の後の返信は late で数えるだけになる。
    const finalization: NonNullable<RuntimeCompositionRoot["finalization"]> = { cutoff: null, fixed: new Set(), closed: false };
    this.finalization = finalization;
    // P3-CK-AC03 (3): 確かめられないまま残る復元由来の intent は、試行の終わりとその結果の更新・返信待ちを反映した後に鳴らさず失効させ、
    // その採用を待ってから要求を止める（試行中は回収の外なので、終わりを待たないと結果の更新が送れず、最終保存に pending で残って
    // 次の起動で待ちがやり直しになる）。
    const settled = () => [...this.intentRequests.values()].every((request) => this.shutdownExcluded(request.place))
      && this.heldUpdates.every((update) => this.shutdownExcluded(executionPlaces[update.unit]));
    if (this.restoredKeys.size !== 0 && this.heldBasis(this.clock()) !== "verified") {
      await Promise.all(Object.values(this.notificationOperations).flatMap((pending) => pending == null ? [] : [pending.terminal]));
      await this.until(settled, active);
      if (active()) this.reclaimExpired(this.clock(), runtimeUnits, true);
    }
    // P3-NL-AC07 (6)(b): 捨てた予約の failed の更新（送出済みの予約の返信が遅れて採用で返ったときの分を含む）と、枠が使用中で待つ更新が
    // 解決するまで、要求を止めない（止めると heldUpdates が消され、復元で通知したか不明になる）。段の期限の内（P3-C3A-AC09）。
    await this.until(settled, active);
    this.requestsStopped = true;
    this.heldUpdates.length = 0;
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
    // P3-NL-AC07 (6)(a): 待ちの締切の timer は停止の開始で外し、以後張らない（releaseWaiting は running の外で張らない）。
    if (this.ackTimer != null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    const failure: { error?: unknown } = {};
    this.onNotificationDispatchFailure = (error) => {
      if (!Object.hasOwn(failure, "error")) failure.error = error;
    };
    try {
      const requested = requestShutdown(this.state, clock, acceptedThroughSequence);
      this.current = requested.state; this.failDetails();
      // Every reservation is void from the shutdown request on (P3-C3A-NOTIFY-ADOPT). P3-NL-AC07 (6)(b): ack を待っていた予約は adapter を
      // 呼ばず、消す前に lastAttempt を failed に戻す更新を送る（消した後は予約が分からない）。
      for (const name of channelNames) {
        const reservation = this.reservations[name];
        if (reservation != null) this.dropWaiting(name, reservation, clock);
      }
      this.reservations = {};
      this.abortAttempts(requested.abortRequests);
      for (const place of places) this.endRefusals(place, clock);
      for (const details of requested.diagnostics) this.enqueueDiagnostic(completeDiagnostic(details, clock, this.state.runId));
      // P3-REC-AC14 (5): 停止の開始で札が残っていれば 10 分を待たずに履歴へ出す（切れている間なら停止の開始までの窓）。
      const window = this.eewWindow?.stop(clock.wallTimeMs);
      if (window != null) this.noteEewWindow(window, clock);
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
          // 最終化の待ち（P3-CK-AC03 (3)）が期限で切れても、ここで要求の停止と closed を確定させる。
          if (this.finalization != null) { this.finalization.closed = true; this.requestsStopped = true; }
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

  // ---- 時計の確かめ（P3-CLOCK-CHECK-001）: 前回の起動から戻った pending の intent を、host が手元の時計を確かめるまで保留する。 ----
  private readonly wallBasis: (at: ClockReading) => WallBasis; private readonly contentBasis: (at: ClockReading) => WallBasis;
  // P3-CK-AC03 (1): startRuntime で戻った pending の intent の鍵。後に生まれた intent は入らないので、件数は復元した pending を越えない。
  private readonly restoredKeys = new Set<string>();

  // P3-CK-AC01 (5): 締切の印を状態より先に見る順は host の wallBasis の中で閉じる。
  private heldBasis(clock: ClockReading): WallBasis {
    return this.restoredKeys.size === 0 ? "verified" : this.wallBasis(clock);
  }

  // P3-CK-AC03 (2): 保留は新しい選択と試行の開始にだけ当てる。試行中の intent を外すと A7 が superseded で止め、確かめた後に再び鳴らしうる。
  private held(intent: NotificationIntent, basis: WallBasis): boolean {
    return basis !== "verified" && this.restoredKeys.has(intentKey(intent)) && !this.attempting(intent);
  }

  // ---- U-F の詳細の口（P3-UFP-AC07）。要求は mailbox に入れない（Q-UFP-DETAIL-PATH）: 受け付けは 8 件、
  // 期限は受付から 2 秒、deferred の owner には 1 件だけで、ほかに仕事が無いときにだけ送る。 ----
  private readonly detailWaiting: DetailEntry[] = [];
  private detailInFlight: DetailEntry | null = null;
  private detailAccepted = 0;

  // done は HTTP の応答の完了か切断で 1 回呼ぶ。受け付けの枠はそのときに初めて戻る。
  requestDetail(input: Readonly<{ streamId: string; detail: WeatherTimeseriesDetailRequest }>):
  { response: Promise<WeatherTimeseriesDetailResponse>; done: () => void } {
    const refuse = (reason: "busy" | "unavailable" | "versionChanged") =>
      ({ response: Promise.resolve<WeatherTimeseriesDetailResponse>({ kind: "error", reason, revision: null }), done: () => {} });
    if (this.current == null || this.state.shutdown.stage !== "running" || this.monitors.deferred.stopped) return refuse("unavailable");
    if (input.streamId !== this.streamId) return refuse("versionChanged");
    if (this.detailAccepted >= DETAIL_LIMIT) return refuse("busy");
    this.detailAccepted += 1;
    let resolve: (response: WeatherTimeseriesDetailResponse) => void = () => {};
    const response = new Promise<WeatherTimeseriesDetailResponse>((settle) => { resolve = settle; });
    // 期限は受付時の絶対時刻（注入時計の monotonic）で持つ。タイマーの実行順に頼らず、送出と返信の採用で時刻を照合する。
    const entry: DetailEntry = { request: input.detail, resolve, settled: false, released: false, due: this.clock().monotonicMs + DETAIL_MS,
      timer: setTimeout(() => {
        const at = this.detailWaiting.indexOf(entry);
        if (at >= 0) this.detailWaiting.splice(at, 1);
        this.settleDetail(entry, { kind: "error", reason: "timeout", revision: null });
      }, DETAIL_MS) };
    entry.timer.unref();
    this.detailWaiting.push(entry);
    this.sendDetail();
    return { response, done: () => {
      if (entry.released) return;
      entry.released = true;
      entry.settled = true;
      clearTimeout(entry.timer);
      this.detailAccepted -= 1;
      const at = this.detailWaiting.indexOf(entry);
      if (at >= 0) this.detailWaiting.splice(at, 1);
    } };
  }

  private settleDetail(entry: DetailEntry, response: WeatherTimeseriesDetailResponse): void {
    if (entry.settled) return;
    // 期限後の答えは、タイマーがまだ走っていなくても timeout にする（P3-UFP-RES-07）。
    if (!(response.kind === "error" && (response.reason === "timeout" || response.reason === "unavailable")) && this.clock().monotonicMs >= entry.due) response = { kind: "error", reason: "timeout", revision: null };
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  // 期限を過ぎた・切断した要求でも owner の返信が来るまで次を送らない。遅い返信はここで捨てる。
  private detailDone(place: ExecutionPlace, reply: Extract<OwnerReply, { kind: "detailDone" }>): void {
    this.monitors[place].sent.detail = null;
    const entry = this.detailInFlight;
    this.detailInFlight = null;
    if (entry != null) this.settleDetail(entry, reply.response);
  }

  private failDetails(): void {
    const response: WeatherTimeseriesDetailResponse = { kind: "error", reason: "unavailable", revision: null };
    for (const entry of this.detailWaiting.splice(0)) this.settleDetail(entry, response);
    if (this.detailInFlight != null) this.settleDetail(this.detailInFlight, response);
    this.detailInFlight = null;
  }

  // pump の後で、deferred の入力も期限の返信待ちも無いときだけ詳細を送る（通常の入力より下位、spec §7.10）。
  // in-flight が無ければ、mailbox は置き場の最も古い入力を必ず選ぶので、deferred 行きの入力は mailbox に残っていない。
  private sendDetail(): void {
    if (this.detailInFlight != null || this.detailWaiting.length === 0 || this.current == null) return;
    if (this.state.shutdown.stage !== "running" || this.monitors.deferred.stopped) { this.failDetails(); return; }
    this.pump();
    if (this.inFlightInputs.has("deferred") || this.outstanding.deferred.deadline) return;
    const entry = this.detailWaiting.shift()!;
    if (this.clock().monotonicMs >= entry.due) { this.settleDetail(entry, { kind: "error", reason: "timeout", revision: null }); this.sendDetail(); return; }
    this.detailInFlight = entry;
    this.post("deferred", { kind: "detail", detail: entry.request });
  }

  // ---- 起動時の辿りとダイジェスト（P3-RECOVERY-001【発注 1】）。digest は run の中だけで持ち、次の起動で作り直す（P3-REC-AC15 (4)）。 ----
  private recoveryDigest: ReturnType<typeof buildDigest> | null = null;

  // P3-REC-AC02: 起動時の起点は owner の restored の返信の境界（InputBoundaries の今の位置は止まっていた間を覆わない、発注前点検 N9）。
  get restoredBoundaries(): Readonly<Partial<Record<RuntimeUnitId, Restored>>> {
    const result: Partial<Record<RuntimeUnitId, Restored>> = {};
    for (const reply of this.restored.values()) for (const unit of reply.units)
      result[unit.unit] = { restoration: unit.restoration.kind, boundary: unit.inputBoundary };
    return result;
  }

  // P3-REC-AC15: 辿りの結果をダイジェストにして snapshot へ載せ、辿れなかった unit を診断に残す（AC03 (4)・AC04）。owner の止まった unit の WARN は出さない（Q-REC-PRECHECK-9 N2。回の後にも来るので stoppedUnit で見る）。
  showRecoveryDigest(results: readonly UnitWalkResult[], starts: Readonly<Partial<Record<RuntimeUnitId, WalkStart>>>, clock: ClockReading): void {
    const { runId } = this.state;
    for (const details of walkDiagnostics(results)) if (details.unit == null || !this.stoppedUnit(details.unit)) this.enqueueDiagnostic(completeDiagnostic(details, clock, runId));
    this.recoveryDigest = buildDigest(results, starts);
    this.project([], [], clock);
  }

  // ---- 切れていた間の EEW の札（H28）と鮮度の突き合わせ（H41）（P3-RECOVERY-001【発注 2】）。どちらも run の中だけで持つ。 ----
  private startedWallMs = 0;
  // 実際に受けた最後の frame（ping・data・start）の wall。起動から 1 つも受けていなければ null（P3-REC-AC14 (1)）。
  private lastFrameWallMs: number | null = null;
  // 今の WS で start を受けた。切断で下ろす。H41 の位置は繋がった後に作る（P3-REC-AC13 (1)）。
  private socketStarted = false;
  private eewWindow: EewWindow | null = null;
  private freshness: Freshness | null = null;

  /** host が受けた frame ごとに 1 回（O(1)）。liveness 用の monotonic とは別の値（P3-REC-AC14 (1)）。 */
  recordFrame(wallTimeMs: number): void { this.lastFrameWallMs = wallTimeMs; }

  /** P3-REC-AC14 (3): 購読に EEW があるとき（{ wsUrl } の起動を含む）だけ、起動の後・最初の接続の前に host が 1 回呼ぶ。 */
  watchEewWindow(): void { this.eewWindow ??= new EewWindow(this.startedWallMs); }

  /**
   * P3-REC-AC13 (5): 起動時の辿りの後に host が 1 回呼ぶ。poll は host の apiKey・lane・停止の signal を閉じた一覧の口。
   * 周期は既存の 1 秒の tick で起こす（start を受けた WS で、位置が無いか 10 分たったとき。新しい timer は作らない）。
   */
  startFreshness(poll: (classification: DmdataClassification, position: PoolPosition | null) => Promise<PollResult>): void {
    if (this.freshness != null) this.freshness.poll ??= poll;
  }

  /**
   * P3-REC-AC13 (8)・RET-02: 帳簿は起動の後・最初の接続の前に作り、辿りの完了を待たずに live の id を集める（購読している telegram.* がある run だけ）。
   * 辿りが 401/403 で周期を起こさない run でも帳簿は持つ（RET-02 の上限の内で積もらない）。
   */
  watchFreshness(classifications: readonly DmdataClassification[]): void {
    if (this.freshness != null || classifications.length === 0) return;
    this.freshness = { classifications, poll: null, ledger: new FreshnessLedger(), positions: new Map(), lastCycleAtMs: null, running: false,
      stopped: false, warned: new Set() };
  }

  /** P3-REC-AC13 (8): host が mailbox に受け取らせた live の入力の id（boundaries.queued の隣）。受信 1 回に O(1)。 */
  recordLiveId(headType: string, dmdataId: string | null, atMonotonicMs: number): void {
    const freshness = this.freshness, row = classifyHeadType(headType);
    if (freshness == null || dmdataId == null || row.status !== "ready" || row.unit === "U-E") return;
    // 突き合わせない区分の id は足さない（最後の成功が進まず掃除されないまま RET-02 を埋める）。
    const classification = freshness.classifications.find((item) => item === familyFor(headType));
    if (classification != null) freshness.ledger.received(row.unit, classification, dmdataId, atMonotonicMs);
  }

  // 切断（P3-REC-AC13 (1)・AC14 (1)）: 札の窓を始め、H41 の位置・保留・帳簿の id を捨てる。進行中の周期は epoch が合わず捨てられる。
  private recoveryLost(): void {
    this.socketStarted = false;
    this.eewConfirm = null;
    this.eewWindow?.lost(this.lastFrameWallMs);
    const freshness = this.freshness;
    if (freshness == null) return;
    freshness.ledger.reset();
    freshness.positions.clear();
    freshness.lastCycleAtMs = null;
  }

  // 1 秒の tick の中: 札の 10 分（AC14 (2)）、保留の 2 分の満了（AC13 (3)(b)）、周期の起こし（AC13 (5)）。
  private watchRecovery(clock: ClockReading): void {
    if (this.state.shutdown.stage !== "running") return;
    const expired = this.eewWindow?.tick(clock.monotonicMs).expired;
    if (expired != null) this.noteEewWindow(expired, clock);
    this.confirmEew(clock);
    this.startWantedRecovery(clock);
    const freshness = this.freshness;
    if (freshness == null) return;
    const due = freshness.ledger.expire(clock.monotonicMs);
    for (const epoch of new Set(due.map((item) => item.epoch)))
      this.dispatch({ kind: "freshnessSuspected", runId: this.state.runId, epoch, clock,
        scopes: due.filter((item) => item.epoch === epoch).map((item) => item.scope) });
    // P3-REC-AC13 (4)・D-FRESHNESS-TRIGGER=A: 疑いは取り直しのきっかけ。起点はその scope の最も古い保留の receivedTime − 60 秒（AC02 (7)）。
    for (const item of due) if (item.epoch === this.state.confirmation.epoch)
      this.requestRecovery([item.scope.unit], { fetchFromMs: item.oldestReceivedAtMs - RECOVERY_MARGIN_MS, digestAfterMs: item.oldestReceivedAtMs,
        stopAtId: null, beforeWindow: false });
    const poll = freshness.poll;
    if (poll == null || !this.socketStarted || freshness.running || freshness.stopped
      || freshness.lastCycleAtMs != null && clock.monotonicMs - freshness.lastCycleAtMs < FRESHNESS_PERIOD_MS) return;
    freshness.running = true;
    freshness.lastCycleAtMs = clock.monotonicMs;
    void this.freshnessCycle(freshness, poll, this.state.confirmation.epoch).finally(() => { freshness.running = false; });
  }

  // 区分ごとに一覧を引き、全ページが揃って epoch が合えば突き合わせる（P3-REC-AC13 (1)〜(3)(7)）。区分は 1 本ずつ（lane が 1 本にする）。
  private async freshnessCycle(freshness: Freshness, poll: NonNullable<Freshness["poll"]>, epoch: number): Promise<void> {
    for (const classification of freshness.classifications) {
      // (c1) 周期の境界は最初の一覧の要求を出す直前の monotonic（lane の待ちの分だけ早いのは掃除を遅らせる側）。
      const cycleStartMs = this.clock().monotonicMs;
      const result = await poll(classification, freshness.positions.get(classification) ?? null)
        .catch((): PollResult => ({ kind: "unmatched", reason: "fetchFailed" }));
      // 切断で epoch が進んだ周期と停止を始めた後の結果は全部捨てる（位置・保留・掃除より前に見る）。
      if (this.state.shutdown.stage !== "running" || this.state.confirmation.epoch !== epoch || this.freshness !== freshness) return;
      if (result.kind === "unmatched") {
        // run で 1 回の WARN（10 分ごとに積もらない）。401/403 は run の残りの H41 を止め、接続には渡さない（AC13 (7)）。
        const reason = result.reason === "authRejected" ? "recoveryAuthRejected" : result.reason === "pageLimit" ? null : "recoveryFetchFailed";
        if (reason != null && !freshness.warned.has(reason)) {
          freshness.warned.add(reason);
          this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "recovery", reason }, this.clock(), this.state.runId));
        }
        if (result.reason !== "authRejected") continue;
        freshness.stopped = true;
        return;
      }
      if (result.kind === "ok") freshness.ledger.compare(classification, result.heads, epoch, cycleStartMs, this.clock().monotonicMs);
      freshness.positions.set(classification, result.position);
    }
  }

  // ---- 取り直し（P3-RECOVERY-001【発注 3】）。1 本ずつ（P3-REC-D-COALESCE=A）。候補は owner が作り、採用の返信で確認と穴の解決を決める。 ----
  // どれも run の中だけで持つ（nonPersistedFields）。
  private recoveryIo: RecoveryIo | null = null;
  // host の受信の順の列（AC05）。無い（試験の root）ときは処理を終えた入力の最大で代える（範囲を狭く読む側）。
  private sequenceOf: Readonly<{ next: () => number; current: () => number }> | null = null;
  private settledSequence = -1;
  // 進み具合（AC11）。辿らない run は null。view は変わったときだけ作り直す（comparable が直列化する、上界は定数）。
  private progress: Map<RuntimeUnitId, RecoveryProgressUnit> | null = null;
  private progressView: readonly RecoveryProgressUnit[] | null = null;
  private runStopped: Set<RuntimeUnitId> | null = null; // 走っている回の停止の帳簿（Q-REC-PRECHECK-9 N2）。null なら回は走っていない。寿命はその回だけ
  // 走っている間に来たきっかけ（やり直しの印）。boundary は穴の起点から、start は鮮度の起点（AC02 (7)）。
  private readonly wanted = new Map<RuntimeUnitId, Readonly<{ boundary: boolean; start: WalkStart | null }>>();
  private recoveryNotBefore = -Infinity;
  // 起動の取り直しが採用で終わっていない unit の起動の範囲（AC02 (7) の最も古い起点）。
  private readonly uncovered = new Map<RuntimeUnitId, WalkStart>();
  // unit×operation ごとの最後の負の証拠の入力番号（AC09 (1)(2)）。
  private readonly negatives = new Map<string, number>();
  private readonly recoveryReplies = new Map<string, Readonly<{ place: ExecutionPlace; done: (reply: RecoveryDone | null) => void }>>();
  // 本文の表（AC05）: mailbox に入れた本文の入力番号 → unit と枠。終わり（inputDone・owner の停止）で消して枠を返す。
  private readonly bodies = new Map<number, Body>();
  private slotsHeld = 0;
  private recoveryCount = 0;
  private eewConfirm: Readonly<{ sinceMs: number; epoch: number; afterSequence: number }> | null = null;
  // P3-REC-AC02（統合担当の決め、発注 3 の r0 Opus P2-1）: 起動の一覧を最初の接続より前に引き始めた run は、最初の start も取り直しのきっかけ
  // （一覧を引き終えてから繋がるまでに出た報は、一覧にも live にも無い）。
  private firstConnectWanted = false;

  /** P3-REC-AC05: host の受信の順の列から番号を 1 つ取る口と今の番号を読む口。取り直しの本文と範囲の終わりはこの列で数える。 */
  attachSequence(next: () => number, current: () => number): void { this.sequenceOf = { next, current }; }

  private currentSequence(): number { return this.sequenceOf?.current() ?? this.settledSequence; }

  private recovering(): boolean { return this.current != null && this.state.shutdown.stage === "running"; }

  /**
   * P3-REC-AC02・AC11: 起動の辿り（listed）をそのまま起動の取り直しにする。host が辿りを始める前に 1 回呼ぶ（範囲の終わりはこの時点の番号）。
   * starts は startupPlan の起点（辿る unit だけ）。本文を流す unit の外は「取り直していない」。
   */
  attachRecovery(io: RecoveryIo, starts: Readonly<Partial<Record<RuntimeUnitId, WalkStart>>>, listed: Promise<readonly UnitWalkResult[]>): void {
    if (this.recoveryIo != null) throw new Error("recovery already attached");
    this.recoveryIo = io;
    this.firstConnectWanted = !this.socketStarted;
    this.progress = new Map(runtimeUnits.filter((unit) => starts[unit] != null).map((unit) => [unit, { unit, state: "notRecovered" }]));
    const units = RECOVERABLE_UNITS.filter((unit) => starts[unit] != null);
    for (const unit of units) this.uncovered.set(unit, starts[unit]!);
    void this.conduct(units, listed, new Map());
  }

  /** P3-REC-AC02 (1): 接続中に host・mailbox が断った入力（穴 b）。繋がっていても取り直しを起こす。 */
  recoveryRefused(headType: string): void {
    const row = classifyHeadType(headType);
    if (row.status === "ready") this.requestRecovery([row.unit], null);
  }

  // きっかけをやり直しの印にする（P3-REC-D-COALESCE=A）。本文を流す unit で辿る unit だけ、停止した owner の unit は外す。
  private requestRecovery(units: readonly RuntimeUnitId[], start: WalkStart | null): void {
    if (this.recoveryIo == null) return;
    for (const unit of units) {
      if (!RECOVERABLE_UNITS.some((item) => item === unit) || this.progress?.has(unit) !== true || this.stoppedUnit(unit)) continue;
      const known = this.wanted.get(unit);
      this.wanted.set(unit, { boundary: (known?.boundary ?? false) || start == null,
        start: start == null ? known?.start ?? null : widerStart(known?.start ?? null, start) });
      // AC11: 予約した時点から取り直し中（前の recovered のままにしない）。
      this.setProgress(unit, { unit, state: "running" });
    }
  }

  // tick の中: 走っていなければ、前の終わりから 60 秒と一覧・本文の待ち（429 の Retry-After を含む、AC03 (9)）の後に、印の unit をまとめて 1 本起こす。
  private startWantedRecovery(clock: ClockReading): void {
    const io = this.recoveryIo;
    if (io == null || this.runStopped != null || this.wanted.size === 0 || clock.monotonicMs < Math.max(this.recoveryNotBefore, io.notBefore())) return;
    const wanted = new Map(this.wanted);
    this.wanted.clear();
    void this.conduct([...wanted.keys()], null, wanted);
  }

  // AC02 (7): 起動の範囲（採用で終わるまで）・既存の穴・きっかけの起点のうち最も古い所から辿る。
  private recoveryStartOf(unit: RuntimeUnitId, wanted: Readonly<{ boundary: boolean; start: WalkStart | null }> | undefined): WalkStart {
    const now = this.clock().wallTimeMs;
    const boundary = this.checkpoint.boundaries.boundary(unit);
    let start: WalkStart | null = this.uncovered.get(unit) ?? null;
    if (boundary?.oldestHole != null || wanted?.boundary === true) start = widerStart(start, recoveryStart(boundary, now, windowOf(unit)));
    if (wanted?.start != null) start = widerStart(start, wanted.start);
    return start ?? recoveryStart(boundary, now, windowOf(unit));
  }

  /** 1 本の取り直し。listed は起動の辿りの結果（null なら計画を作って一覧を辿る）。unit は順に 1 つずつ候補を作る（AC05）。 */
  private async conduct(requested: readonly RuntimeUnitId[], listed: Promise<readonly UnitWalkResult[]> | null,
    wanted: ReadonlyMap<RuntimeUnitId, Readonly<{ boundary: boolean; start: WalkStart | null }>>): Promise<void> {
    const io = this.recoveryIo!;
    this.runStopped = new Set();
    // recoveryId に結ぶ epoch と範囲の終わり（一覧を引き始めた時点の番号、AC07・AC09 (1)・AC19 (2)）。
    const run = { epoch: this.state.confirmation.epoch, listSequence: this.currentSequence() };
    const units: RuntimeUnitId[] = []; let passed = 0; // passed は catch の帳簿（N3）: loop の 1 回分を正常に抜けた unit の数
    for (const unit of WALK_ORDER.filter((item) => requested.includes(item))) { // Q-REC-PRECHECK-8 N7: 本文と RES-03 を P3-REC-D-ORDER-AND-LIMIT=A の固定順で数える
      if (this.stoppedUnit(unit)) { this.recoveryUnsatisfied(unit, "ownerStopped"); continue; }
      units.push(unit);
      this.checkpoint.boundaries.recoveryStarted(unit, run.listSequence);
      this.setProgress(unit, { unit, state: "running" });
    }
    if (units.length !== 0) this.project([], [], this.clock());
    try {
      const starts = Object.fromEntries(units.map((unit) => [unit, this.recoveryStartOf(unit, wanted.get(unit))]));
      const results = listed != null ? await listed : units.length === 0 ? [] : await io.walk(recoveryPlan(io.classifications, starts, units));
      // 起動の辿りの WARN はダイジェストの側が出した（showRecoveryDigest）。owner の止まった unit の WARN は出さない（N2、作者裁定 A）。
      if (listed == null && this.recovering())
        for (const details of walkDiagnostics(results)) if (details.unit == null || !this.stoppedUnit(details.unit)) this.enqueueDiagnostic(completeDiagnostic(details, this.clock(), this.state.runId));
      let budget = BODY_BUDGET;
      let ended: RecoveryUnsatisfiedReason | null = null;
      for (; passed < units.length; passed += 1) { // passed は continue を含む正常な抜けでだけ進む
        const unit = units[passed]; if (!this.recovering()) return;
        const result = results.find((item) => item.unit === unit);
        if (result == null) { this.setProgress(unit, { unit, state: "notRecovered" }); continue; }
        // 401/403 の WARN は 1 回の取り直しに 1 件（AC03 (3)）。量の上限は unit ごと（AC04）。
        if (ended === "authRejected") { this.setProgress(unit, { unit, state: "unsatisfied", reason: ended }); continue; }
        if (ended != null) { this.recoveryUnsatisfied(unit, ended); continue; }
        if (result.kind === "unsatisfied") {
          this.setProgress(unit, { unit, state: "unsatisfied", reason: result.reason === "recoveryLimit" ? "recoveryLimit" : result.reason });
          continue;
        }
        // RES-03: 論理の本文の件数。上限に当たった unit から後ろを recoveryLimit にする（AC04）。
        const heads = bodiesFor(unit, result.heads.filter((head) => head.receivedAtMs >= starts[unit].fetchFromMs)); // Q-REC-PRECHECK-10 N3: 本文は N2 の窓の内だけ（起動の一覧は 7 日まで辿る）
        if (heads.length > budget) { ended = "recoveryLimit"; this.recoveryUnsatisfied(unit, ended); continue; }
        budget -= heads.length;
        const stopped = await this.recoverUnit(io, run, unit, heads, result.heads);
        if (stopped != null) ended = stopped;
      }
    } catch {
      // 一覧の口の例外は取り直しの失敗だけにし、live の受信を止めない。印のある unit は抜けても running を見せるので、表示でなく帳簿で選ぶ（N3）。
      for (const unit of units.slice(passed)) this.recoveryUnsatisfied(unit, "fetchFailed");
    } finally {
      this.runStopped = null;
      this.recoveryNotBefore = this.clock().monotonicMs + RECOVERY_GAP_MS;
      // やり直しの印がある unit は、終わった結果ではなく取り直し中（AC11）。
      for (const unit of this.wanted.keys()) this.setProgress(unit, { unit, state: "running" });
      // P3-REC-AC13 (1)（発注 3 の点検 M2）: 取り直しの終わりの次の tick で突き合わせる。
      if (this.freshness != null) this.freshness.lastCycleAtMs = null;
      if (this.recovering()) this.project([], [], this.clock());
    }
  }

  /**
   * 1 unit の候補（AC05〜AC07）。open → 本文を 1 件ずつ取って mailbox へ（枠は RES-01 の 2 件）→ 表の本文が全部終わってから adopt（失敗なら discard）。
   * 戻り値は残りの unit を止める理由（401/403 は authRejected、429 の尽きは fetchFailed、AC03 (3)(4)）。
   */
  private async recoverUnit(io: RecoveryIo, run: Readonly<{ epoch: number; listSequence: number }>, unit: RuntimeUnitId, heads: readonly ListHead[],
    listed: readonly ListHead[]): Promise<RecoveryUnsatisfiedReason | null> {
    const place = executionPlaces[unit];
    const recoveryId = `${run.epoch}/${++this.recoveryCount}`;
    if (await this.askRecovery(place, recoveryId, unit, "open") == null) { this.recoveryUnsatisfied(unit, "ownerStopped"); return null; }
    const table = new Map<number, Operation>();
    const counter = { pending: 0 };
    let failure: "fetchFailed" | "authRejected" | "throttled" | null = null;
    for (const head of heads) {
      await this.until(() => this.slotsHeld < BODY_SLOTS, () => this.recovering());
      if (!this.recovering() || this.stoppedUnit(unit)) break;
      // RES-01: 枠は HTTP の要求の前から取得の側が持ち、enqueue の受け付けで本文の表へ渡す（どの経路でも 1 回だけ返す）。
      const slot = { returned: false };
      this.slotsHeld += 1;
      const fetched = await io.fetchBody(head);
      const sequence = fetched.kind === "ok" && this.recovering() && !this.stoppedUnit(unit) ? this.sendBody(unit, head, fetched.bytes, slot, counter) : null;
      if (sequence == null) {
        this.releaseSlot(slot);
        if (!this.recovering() || this.stoppedUnit(unit)) break;
        failure = fetched.kind === "authRejected" ? "authRejected" : fetched.kind === "throttled" ? "throttled" : "fetchFailed";
        break;
      }
      table.set(sequence, head.operation);
    }
    // AC05: mailbox の本文と recovery の要求は別の経路なので、表の本文が全部終わってから次の要求を送る。
    await this.until(() => counter.pending === 0, () => this.recovering());
    if (!this.recovering()) return null; // 停止の開始の後は adopt を送らない（owner は shutdownInput で候補を捨てる）
    if (this.stoppedUnit(unit)) { this.recoveryUnsatisfied(unit, "ownerStopped"); return null; }
    if (failure != null) {
      await this.askRecovery(place, recoveryId, unit, "discard");
      this.recoveryUnsatisfied(unit, failure === "authRejected" ? "authRejected" : "fetchFailed");
      return failure === "fetchFailed" ? null : failure === "authRejected" ? "authRejected" : "fetchFailed";
    }
    const reply = await this.askRecovery(place, recoveryId, unit, "adopt");
    if (reply == null) { this.recoveryUnsatisfied(unit, "ownerStopped"); return null; }
    this.recoveryAdopted(run, unit, reply, table, listed);
    return null;
  }

  // 本文 1 件を origin=recovery の入力として ingress → mailbox へ（AC05）。受信時刻は一覧の receivedTime（P3-REC-D-RECEIVED-AT=A）。
  private sendBody(unit: RuntimeUnitId, head: ListHead, bytes: Uint8Array, slot: Slot, counter: { pending: number }): number | null {
    const sequence = this.sequenceOf?.next() ?? ++this.settledSequence;
    const inputId = `input-${sequence}`;
    const ingressed = ingestXmlData({ kind: "rest", inputId, inputSequence: sequence, receivedAt: head.receivedAtMs, origin: "recovery", body: bytes,
      headType: head.headType, headTest: head.test, controlStatus: head.controlStatus, dmdataId: head.id });
    if (ingressed.kind === "rejected") return null;
    const now = this.clock().monotonicMs;
    const enqueued = this.mailbox.enqueue({ messageId: inputId, runId: this.state.runId, t0MonotonicMs: now, enqueuedMonotonicMs: now,
      priorityReason: "normal", payload: { kind: "parser", item: ingressed.item } });
    if (enqueued.kind !== "accepted") return null;
    this.bodies.set(sequence, { unit, slot, counter });
    counter.pending += 1;
    this.pump();
    return sequence;
  }

  private releaseSlot(slot: Slot): void {
    if (slot.returned) return;
    slot.returned = true;
    this.slotsHeld -= 1;
    this.wake();
  }

  private endBody(sequence: number, body: Body): void {
    this.bodies.delete(sequence);
    body.counter.pending -= 1;
    this.releaseSlot(body.slot);
  }

  private askRecovery(place: ExecutionPlace, recoveryId: string, unit: RuntimeUnitId, phase: "open" | "adopt" | "discard"): Promise<RecoveryDone | null> {
    if (this.monitors[place].stopped) return Promise.resolve(null);
    return new Promise((done) => {
      this.recoveryReplies.set(recoveryId, { place, done });
      this.post(place, { kind: "recovery", recoveryId, unit, phase });
    });
  }

  // owner の停止: 待っている要求を外し、その場所の本文を終わりにする（mailbox は removePlace で外した。AC05 の本文の終わり）。
  private recoveryOwnerStopped(units: readonly RuntimeUnitId[]): void {
    for (const [recoveryId, waiting] of this.recoveryReplies) if (placeUnits(waiting.place).some((unit) => units.includes(unit))) {
      this.recoveryReplies.delete(recoveryId);
      waiting.done(null);
    }
    for (const [sequence, body] of this.bodies) if (units.includes(body.unit)) this.endBody(sequence, body);
    // P3-REC-D-COALESCE=A・Q-REC-PRECHECK-9 N2: 停止した owner の unit は範囲ときっかけから外し、走っている回でも即時に ownerStopped にしてから停止の帳簿に入れる（逆の順だと帳簿の門がこの書き込みも止める）。
    for (const unit of RECOVERABLE_UNITS) if (units.includes(unit) && this.progress?.has(unit) === true) {
      this.wanted.delete(unit);
      this.recoveryUnsatisfied(unit, "ownerStopped"); this.runStopped?.add(unit);
    }
  }

  /**
   * 採用の返信（AC06 (b)・AC07・AC09・AC19）。送った本文が全部 adopted で、epoch が始めた時と同じときだけ、範囲の後に負の証拠の無い normal・training に
   * coverageVerified を出し、穴を解く。容量・読めない報の結果は負の証拠の台帳に入れる（確認を止める）。
   */
  private recoveryAdopted(run: Readonly<{ epoch: number; listSequence: number }>, unit: RuntimeUnitId, reply: RecoveryDone, table: ReadonlyMap<number, Operation>,
    listed: readonly ListHead[]): void {
    const { result } = reply;
    if (result.kind !== "adopted") {
      this.recoveryUnsatisfied(unit, result.kind === "generationConflict" ? "generationConflict" : result.kind === "unsatisfied" ? result.reason : "fetchFailed");
      return;
    }
    const results = new Map(result.inputs.map((item) => [item.inputSequence, item.result]));
    let complete = true;
    for (const [sequence, operation] of table) {
      const seen = results.get(sequence);
      if (seen !== "adopted") complete = false;
      if (seen === "capacityExceeded" || seen === "unreadableReport") this.noteNegative(unit, operation, sequence);
    }
    const clock = this.clock();
    const same = this.state.confirmation.epoch === run.epoch;
    if (complete && same) {
      // AC19 (2)(5): 覆った区間の終わりは一覧を引き始めた時点の番号と、最後に一覧で見た item の dmdata 時刻と電文 id。
      let newest: ListHead | null = null;
      for (const head of listed) if (newest == null || head.receivedAtMs > newest.receivedAtMs) newest = head;
      this.checkpoint.boundaries.resolve(unit, run.listSequence, { receivedAt: null, dmdataTime: newest?.receivedAtMs ?? null, dmdataId: newest?.id ?? null });
      this.uncovered.delete(unit);
      this.setProgress(unit, { unit, state: "recovered" });
    } else if (same) this.recoveryUnsatisfied(unit, "fetchFailed");
    // 解決の後にも穴（取り直しの間に断った入力ほか）が残る unit には確認を出さない（統合担当の決め、r0 Opus (C)）。
    const scopes = complete && same && !this.checkpoint.boundaries.hasHole(unit)
      ? recoveredOperations.filter((operation) => (this.negatives.get(`${unit}/${operation}`) ?? -Infinity) <= run.listSequence)
        .map((operation) => ({ unit, kind: "unit" as const, operation })) : [];
    if (scopes.length !== 0) this.dispatch({ kind: "coverageVerified", runId: this.state.runId, epoch: run.epoch, scopes, clock });
    // 間に切断があった候補は確認も穴の解決もしない。繋がり直しのきっかけのやり直しが新しい epoch で覆う（AC07）。
    this.project([{ unit, outcome: { kind: "recoveryAdopted", generation: result.generation,
      coverage: scopes.map((scope) => `${unit}/${scope.operation}`), subjects: this.state.mirror[unit].view.subjects } }], [], clock);
  }

  // 未充足（AC11）: 進み具合と、unit ごとに WARN を 1 件（DiagnosticDetails に理由の欄が無いので語で分ける）。停止の帳簿の unit は WARN も止める（N2）。
  private recoveryUnsatisfied(unit: RuntimeUnitId, reason: RecoveryUnsatisfiedReason): void {
    this.setProgress(unit, { unit, state: "unsatisfied", reason });
    if (this.current == null || this.runStopped?.has(unit) === true) return;
    this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "recovery", reason: unsatisfiedWords[reason], unit }, this.clock(), this.state.runId));
  }

  private setProgress(unit: RuntimeUnitId, item: RecoveryProgressUnit): void {
    if (this.progress == null || this.runStopped?.has(unit) === true) return; // N2: 停止の後のその回の書き込みは捨てる（owner は戻らない）
    this.progress.set(unit, this.wanted.has(unit) ? { unit, state: "running" } : item); // N1: 印は取り直しのやり直しの宣言で、結果は次の回が上書きする（WARN は結果どおり）
    this.progressView = [...this.progress.values()];
  }

  private noteNegative(unit: RuntimeUnitId, operation: Operation, sequence: number): void {
    const key = `${unit}/${operation}`;
    if (sequence > (this.negatives.get(key) ?? -Infinity)) this.negatives.set(key, sequence);
  }

  // P3-REC-AC09 (4)・D-EEW-CONFIRM=B: 繋がりから 10 分、切断が無ければ U-E の normal・training に 1 回。その接続の後に負の証拠のある operation は出さない。
  private confirmEew(clock: ClockReading): void {
    const confirm = this.eewConfirm;
    if (confirm == null || clock.monotonicMs - confirm.sinceMs < EEW_CONFIRM_MS) return;
    this.eewConfirm = null;
    const scopes = confirmedOperations.filter((operation) => (this.negatives.get(`U-E/${operation}`) ?? -Infinity) <= confirm.afterSequence)
      .map((operation) => ({ unit: "U-E" as const, kind: "unit" as const, operation }));
    if (scopes.length !== 0) this.dispatch({ kind: "coverageVerified", runId: this.state.runId, epoch: confirm.epoch, scopes, clock });
  }

  // P3-REC-AC14 (5): 札の窓を WARN の履歴に 1 件。timestamp は窓の終わり、durationMs は窓の長さ、同じ行を畳ませないよう count 1 を明示する。
  private noteEewWindow(window: EewWindowCard, clock: ClockReading): void {
    this.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "recovery", reason: "eewWindowUnverified",
      durationMs: window.toWallMs - window.fromWallMs, count: 1 }, { wallTimeMs: window.toWallMs, monotonicMs: clock.monotonicMs }, this.state.runId));
  }
}

const FRESHNESS_PERIOD_MS = 10 * 60_000; // P3-REC-D-FRESHNESS-PERIOD=A
// P3-RECOVERY-001【発注 3】の置き値と上限。
const RECOVERY_GAP_MS = 60_000; // P3-REC-D-COALESCE=A: 終わりから次の始まりまで
const RECOVERY_MARGIN_MS = 60_000; // P3-REC-AC02 (7): 鮮度の起点の余白
const BODY_BUDGET = 300; // P3-REC-RES-03
const BODY_SLOTS = 2; // P3-REC-RES-01
const EEW_CONFIRM_MS = 10 * 60_000; // P3-REC-D-EEW-CONFIRM=B
// coverageVerified を出す運用区分（test の slot は startup のまま、AC09 (1)）。
const confirmedOperations = ["normal", "training"] as const;
// 取り直しの採用で確認するのは normal だけ（統合担当の決め 2026-10-28: 一覧は head.test が true の item を捨てるので訓練の報は流れず、
// training の slot は見ていない。AC01）。U-E の 10 分の確認は confirmedOperations のまま。
const recoveredOperations = ["normal"] as const;
const unsatisfiedWords: Readonly<Record<RecoveryUnsatisfiedReason, DiagnosticReason>> = { fetchFailed: "recoveryFetchFailed", recoveryLimit: "recoveryLimit",
  authRejected: "recoveryAuthRejected", generationConflict: "recoveryGenerationConflict", baseMissing: "recoveryBaseMissing",
  clockEvidenceMissing: "recoveryClockEvidenceMissing", ownerStopped: "recoveryOwnerStopped" };
type RecoveryDone = Extract<OwnerReply, { kind: "recoveryDone" }>;
// host が渡す取り直しの口（apiKey は host にしか無い）。notBefore は一覧と本文の待ちの遅い方（AC03 (9)）。
type RecoveryIo = Readonly<{
  classifications: readonly DmdataClassification[];
  walk: (plan: readonly UnitWalk[]) => Promise<readonly UnitWalkResult[]>;
  fetchBody: (head: ListHead) => Promise<BodyResult>;
  notBefore: () => number;
}>;
// RES-01 の枠 1 つ。returned は返したかの印（2 回目は何もしない）。
type Slot = { returned: boolean };
type Body = Readonly<{ unit: RuntimeUnitId; slot: Slot; counter: { pending: number } }>;
// H41 の run の中の状態。warned は run で 1 回に限る WARN の語、stopped は 401/403 で止めた印。
type Freshness = {
  readonly classifications: readonly DmdataClassification[];
  // 一覧の口。起動時の辿りの後に host が付ける（null の間は帳簿だけで周期を回さない）。
  poll: ((classification: DmdataClassification, position: PoolPosition | null) => Promise<PollResult>) | null;
  readonly ledger: FreshnessLedger;
  readonly positions: Map<DmdataClassification, PoolPosition>;
  lastCycleAtMs: number | null;
  running: boolean;
  stopped: boolean;
  readonly warned: Set<"recoveryAuthRejected" | "recoveryFetchFailed">;
};

const DETAIL_LIMIT = 8;
const DETAIL_MS = 2_000;
type DetailEntry = { request: WeatherTimeseriesDetailRequest; resolve: (response: WeatherTimeseriesDetailResponse) => void;
  due: number; timer: NodeJS.Timeout; settled: boolean; released: boolean };

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
    "U-B": mark(), "U-M": mark(), "U-Y": mark() };
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
  nodeDiagnosticFileSystem, places, sharedClock, snapshotInput, writeCounters };
export type { CompositionOptions, NotificationCalls, ProjectedStep, PublisherInput, RecoveryIo, ShutdownHooks, WriteCounters };
