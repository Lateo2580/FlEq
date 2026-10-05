import { createHash } from "node:crypto";
import { join } from "node:path";

import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  CheckpointCapture,
  CheckpointEnvelope,
  CheckpointRequest,
  CheckpointResult,
  ClockReading,
  DiagnosticEvent,
  JsonValue,
  PersistenceStatus,
  RestoreUnitResult,
  RuntimeUnitStates,
  RuntimeUnitId,
  UnitCodec,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { completeDiagnostic } from "../runtime/runtime-diagnostic";
import { runtimeUnits } from "../runtime/unit-coverage";

type WritableCheckpoint = Readonly<{
  write(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

type CheckpointFileSystem = Readonly<{
  readFile(path: string): Uint8Array | null;
  unlinkSync(path: string): void; // Missing files are already reclaimed.
  mkdir(path: string): Promise<void>;
  open(path: string): Promise<WritableCheckpoint>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}>;

type CodecMap<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> = Readonly<{
  [Unit in keyof UnitStates]?: UnitCodec<UnitStates[Unit], JsonValue>;
}>;

type Correlation = Pick<CheckpointMeasurement, "inputIds" | "retryReason">;

type Attempt = {
  request: CheckpointRequest | null;
  unit: UnitId;
  generation: number;
  runId: string;
  inputIds: readonly string[];
  retryReason: CheckpointMeasurement["retryReason"];
  capturedAt: number;
  phase: "reserved" | "running" | "ended";
  failedStage?: CheckpointMeasurement["stage"];
  renamed?: boolean;
  fileSynced?: boolean;
  acknowledged?: boolean;
  bytes?: Uint8Array; // The one serialization of request.envelope (AC03); never added to the shared CheckpointRequest.
};

type Slot = "A" | "B";
type SlotRead = Readonly<{ slot: Slot; envelope: CheckpointEnvelope }>;
type SlotInvalid = "missing" | "invalid" | "unknownSchema";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const retryDelays = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

function envelopeBytes(
  envelope: Omit<CheckpointEnvelope, "sha256">,
  sha256 = "0".repeat(64),
): Uint8Array {
  return encoder.encode(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    unit: envelope.unit,
    generation: envelope.generation,
    capturedAt: envelope.capturedAt,
    payload: envelope.payload,
    sha256,
  }));
}

// AC03: serialize once; the stored bytes are the zeroed form with its last 64 hex digits overwritten
// (the position readSlot zeroes), byte-identical to serializedEnvelope(hashEnvelope(envelope)).
function sealEnvelope(envelope: Omit<CheckpointEnvelope, "sha256">): Readonly<{ envelope: CheckpointEnvelope; bytes: Uint8Array }> {
  const bytes = envelopeBytes(envelope);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  bytes.set(encoder.encode(sha256), bytes.byteLength - 66);
  return { envelope: { ...envelope, sha256 }, bytes };
}

function hashEnvelope(envelope: Omit<CheckpointEnvelope, "sha256">): CheckpointEnvelope {
  return sealEnvelope(envelope).envelope;
}

function serializedEnvelope(envelope: CheckpointEnvelope): Uint8Array {
  return envelopeBytes(envelope, envelope.sha256);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const failureReasons = {
  encode: "checkpointEncodeFailed",
  write: "checkpointWriteFailed",
  fileSync: "checkpointFileSyncFailed",
  close: "checkpointCloseFailed",
  rename: "checkpointRenameFailed",
  directorySync: "checkpointDirectorySyncFailed",
  verify: "checkpointVerifyFailed",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : "checkpoint operation failed";
}

// P3-C3A-WRITE-RIGHT: the owner's side of checkpointing. It captures, encodes, hashes, writes and reconciles the
// owner's own units, remembers their valid slot (C1) and keeps a failed generation's bytes for a same-generation
// retry. When to save and how long to wait after a failure is the publisher's (CheckpointWriter below).
class CheckpointCoordinator<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> {
  private readonly attempts = new Map<string, Attempt>();
  // AC09: a retry of the same generation keeps its original envelope identity; request and bytes travel as a pair.
  private readonly held = new Map<UnitId, Readonly<{ request: CheckpointRequest; bytes: Uint8Array; fileSynced?: boolean }>>();
  // AC01: per unit, the slot this writer last knew to be valid (null = known empty, absent = unknown).
  // Without it every save re-reads both slots (ledger 55).
  private readonly knowledge = new Map<UnitId, Readonly<{ slot: Slot; generation: number; sha256: string }> | null>();
  private attemptSequence = 0;

  // readClock: wallTimeMs is business time (capturedAt, ackAt), monotonicMs is the measured clock of CheckpointMeasurement.
  constructor(
    private readonly directory: string,
    private readonly codecs: CodecMap<UnitStates>,
    private readonly fileSystem: CheckpointFileSystem,
    private readonly readClock: () => ClockReading,
    private readonly emitDiagnostic: (event: DiagnosticEvent) => void,
  ) {
    // Startup has no live writer; keep restoreUnit's synchronous boundary.
    for (const unit of Object.keys(codecs) as UnitId[]) {
      try { this.removeTemporaries(unit); }
      catch { this.restoreRejected(unit, "noValidSlot"); }
    }
  }

  restoreUnit(unit: UnitId): RestoreUnitResult {
    const result = this.readUnit(unit);
    if (result.kind === "restored") this.knowledge.set(unit, { slot: result.slot,
      generation: result.envelope.generation, sha256: result.envelope.sha256 });
    else if (result.kind === "empty") this.knowledge.set(unit, null);
    else this.knowledge.delete(unit);
    return result;
  }

  saves(unit: UnitId): boolean {
    return this.codec(unit) != null;
  }

  private readUnit(unit: UnitId): RestoreUnitResult {
    const codec = this.codec(unit);
    if (codec == null) {
      this.restoreRejected(unit, "unknownSchema");
      return { kind: "unavailable", reason: "unknownSchema" };
    }
    let slots: (SlotRead | SlotInvalid)[];
    try { slots = (["A", "B"] as const).map((slot) => this.readSlot(unit, slot, codec)); }
    catch {
      this.restoreRejected(unit, "noValidSlot");
      return { kind: "unavailable", reason: "noValidSlot" };
    }
    const [left, right] = slots;
    if (left === "missing" && right === "missing") return { kind: "empty" };
    const valid = [left, right].filter((slot): slot is SlotRead => typeof slot !== "string");
    if (valid.length === 0) {
      const reason = left === "unknownSchema" || right === "unknownSchema" ? "unknownSchema" : "noValidSlot";
      this.restoreRejected(unit, reason);
      return { kind: "unavailable", reason };
    }
    if (valid.length === 2 && valid[0].envelope.generation === valid[1].envelope.generation
      && valid[0].envelope.sha256 !== valid[1].envelope.sha256) {
      this.restoreRejected(unit, "conflictingGeneration");
      return { kind: "unavailable", reason: "conflictingGeneration" };
    }
    const selected = valid.reduce((latest, candidate) =>
      candidate.envelope.generation > latest.envelope.generation ? candidate : latest);
    return { kind: "restored", envelope: selected.envelope, slot: selected.slot };
  }

  // The capture of one granted save: the generation current when the grant is applied, encoded once (C1 RES-03).
  capture(unit: RuntimeUnitId, value: unknown, generation: number, runId: string, correlation: Correlation)
    : Readonly<{ capture: CheckpointCapture; request: CheckpointRequest; result: null; measurements: readonly CheckpointMeasurement[] }>
    | Readonly<{ capture: CheckpointCapture; request: null; result: Extract<CheckpointResult, { kind: "failed" }> & Readonly<{ stage: "encode" }>; measurements: readonly CheckpointMeasurement[] }> {
    const codec = this.codec(unit);
    if (codec == null) throw new Error(`unit ${unit} has no checkpoint codec`);
    const attemptId = `${runId}:${unit}:${generation}:${++this.attemptSequence}`;
    const started = this.readClock();
    const prior = this.held.get(unit);
    const retained = prior?.request.generation === generation ? prior : null;
    const capturedAt = retained?.request.capturedAt ?? started.wallTimeMs;
    const capture: CheckpointCapture = { attemptId, unit, generation, capturedAt };
    try {
      if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isFinite(capturedAt)
        || JSON.stringify(generation).length > 32 || JSON.stringify(capturedAt).length > 32)
        throw new RangeError("invalid checkpoint generation or capture time");
      const { envelope, bytes } = retained != null
        ? { envelope: retained.request.envelope, bytes: retained.bytes }
        : sealEnvelope({ schemaVersion: codec.schemaVersion, unit, generation, capturedAt, payload: codec.encode(value) });
      const encodedByteLength = bytes.byteLength;
      // A newer generation supersedes the held bytes (up to the whole payload); only a same-generation retry reuses them.
      if (prior != null && retained == null) this.held.delete(unit);
      const ended = this.readClock();
      const request: CheckpointRequest = {
        attemptId, unit, generation, reservedAt: started.monotonicMs, capturedAt,
        envelope, encodedByteLength,
      };
      this.attempts.set(attemptId, { request, unit, generation, runId, inputIds: [...correlation.inputIds],
        retryReason: correlation.retryReason, capturedAt, phase: "reserved", bytes, fileSynced: retained?.fileSynced });
      return { capture, request, result: null, measurements: retained != null ? []
        : [this.measurement(request, "encode", started.monotonicMs,
          ended.monotonicMs, encodedByteLength, "succeeded", runId, correlation)] };
    } catch (error) {
      const ended = this.readClock();
      const result = {
        kind: "failed", attemptId, unit, generation, failedAt: ended.wallTimeMs,
        stage: "encode", reason: errorMessage(error), encodedByteLength: 0,
      } as const;
      this.attempts.set(attemptId, { request: null, unit, generation, runId, inputIds: [...correlation.inputIds],
        retryReason: correlation.retryReason, capturedAt, phase: "ended" });
      return { capture, request: null, result, measurements: [{
        runId, inputIds: [...correlation.inputIds], unit, generation, attemptId, stage: "encode",
        startedMonotonicMs: started.monotonicMs, endedMonotonicMs: ended.monotonicMs,
        bytes: 0, outcome: "failed", retryReason: correlation.retryReason,
      }] };
    }
  }

  async executeCheckpoint(
    request: CheckpointRequest,
    runId: string,
    inputIds: readonly string[],
    retryReason: CheckpointMeasurement["retryReason"],
  ): Promise<Readonly<{ result: CheckpointResult; measurements: readonly CheckpointMeasurement[] }>> {
    const attempt = this.attempts.get(request.attemptId);
    if (attempt == null || attempt.request?.attemptId !== request.attemptId
      || attempt.unit !== request.unit || attempt.generation !== request.generation
      || attempt.request.envelope.sha256 !== request.envelope.sha256 || attempt.bytes == null
      || attempt.request.encodedByteLength !== request.encodedByteLength || attempt.runId !== runId
      || attempt.retryReason !== retryReason || !sameStrings(attempt.inputIds, inputIds))
      throw new Error("checkpoint correlation mismatch");
    if (attempt.phase !== "reserved") throw new Error("checkpoint attempt already executed");
    attempt.phase = "running";

    const measurements: CheckpointMeasurement[] = [];
    const byteLength = request.encodedByteLength;
    const bytes = attempt.bytes;
    let writable: WritableCheckpoint | null = null;
    let stage: CheckpointMeasurement["stage"] = "write";
    let stageStarted = this.readClock().monotonicMs;
    try {
      // AC02(3): a memory at the requested generation may come from a reconciliation read, so it is no proof
      // of a finished save; drop it and take the recovery path (spec:843 re-sync and re-read stay).
      let known = this.knowledge.get(request.unit);
      if (known?.generation === request.generation) { this.knowledge.delete(request.unit); known = undefined; }
      if (known === undefined) {
        const existing = this.restoreUnit(request.unit);
        if (existing.kind === "unavailable") throw new Error(`checkpoint slot unavailable: ${existing.reason}`);
        if (existing.kind === "restored" && existing.envelope.generation === request.generation) {
          if (existing.envelope.sha256 !== request.envelope.sha256)
            throw new Error("checkpoint generation conflicts with slot");
          attempt.renamed = true;
          stage = "directorySync";
          let started = stageStarted = this.readClock().monotonicMs;
          await this.fileSystem.syncDirectory(this.directory);
          measurements.push(this.measurement(request, stage, started, this.readClock().monotonicMs,
            0, "succeeded", runId, attempt));
          stage = "verify";
          started = stageStarted = this.readClock().monotonicMs;
          const confirmed = this.readSlot(request.unit, existing.slot, this.codec(request.unit)!);
          if (typeof confirmed === "string" || confirmed.envelope.sha256 !== request.envelope.sha256)
            throw new Error("existing checkpoint did not verify");
          measurements.push(this.measurement(request, stage, started, this.readClock().monotonicMs,
            byteLength, "succeeded", runId, attempt));
          // The attempt's ack overrides whatever a restoreUnit() during the sync left in memory.
          this.knowledge.set(request.unit, { slot: existing.slot, generation: request.generation, sha256: request.envelope.sha256 });
          attempt.acknowledged = true;
          return { result: { kind: "acknowledged", attemptId: request.attemptId, unit: request.unit,
            generation: request.generation, ackAt: this.readClock().wallTimeMs,
            encodedByteLength: byteLength }, measurements };
        }
        known = this.knowledge.get(request.unit) ?? null;
      }
      if (known != null && known.generation > request.generation) throw new Error("checkpoint generation is older than slot");
      // Ownership is held until this attempt (including close cleanup) has ended.
      this.removeTemporaries(request.unit);
      const slot: Slot = known?.slot === "A" ? "B" : "A";
      const target = this.slotPath(request.unit, slot);
      const temporary = join(this.directory, `${request.unit}.json.tmp`);
      await this.fileSystem.mkdir(this.directory);
      let started = stageStarted = this.readClock().monotonicMs;
      writable = await this.fileSystem.open(temporary);
      await writable.write(bytes);
      let ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, "write", started, ended, bytes.byteLength, "succeeded", runId, attempt));

      stage = "fileSync";
      started = stageStarted = this.readClock().monotonicMs;
      await writable.sync();
      attempt.fileSynced = true;
      ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, stage, started, ended, 0, "succeeded", runId, attempt));

      stage = "close";
      started = stageStarted = this.readClock().monotonicMs;
      await writable.close();
      writable = null;
      ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, stage, started, ended, 0, "succeeded", runId, attempt));

      stage = "rename";
      started = stageStarted = this.readClock().monotonicMs;
      await this.fileSystem.rename(temporary, target);
      attempt.renamed = true;
      ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, stage, started, ended, 0, "succeeded", runId, attempt));

      stage = "directorySync";
      started = stageStarted = this.readClock().monotonicMs;
      await this.fileSystem.syncDirectory(this.directory);
      ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, stage, started, ended, 0, "succeeded", runId, attempt));
      // The save is complete at directory sync; no read-back (the OS cache proves no durability).
      this.knowledge.set(request.unit, { slot, generation: request.generation, sha256: request.envelope.sha256 });
      attempt.acknowledged = true;
      return { result: { kind: "acknowledged", attemptId: request.attemptId, unit: request.unit,
        generation: request.generation, ackAt: this.readClock().wallTimeMs, encodedByteLength: bytes.byteLength }, measurements };
    } catch (error) {
      attempt.failedStage = stage;
      if (writable != null) try { await writable.close(); } catch { /* the original stage owns the result */ }
      const now = this.readClock();
      measurements.push(this.measurement(request, stage, stageStarted, now.monotonicMs,
        stage === "write" || stage === "verify" ? byteLength : 0, "failed", runId, attempt));
      const uncertain = attempt.renamed || stage === "rename";
      if (uncertain) this.knowledge.delete(request.unit);
      return { result: uncertain
        ? { kind: "uncertain", attemptId: request.attemptId, unit: request.unit, generation: request.generation,
            observedAt: now.wallTimeMs, stage: stage === "verify" ? "ack" : stage as "rename" | "directorySync", encodedByteLength: byteLength }
        : { kind: "failed", attemptId: request.attemptId, unit: request.unit, generation: request.generation,
            failedAt: now.wallTimeMs, stage, reason: errorMessage(error), encodedByteLength: byteLength }, measurements };
    } finally {
      attempt.phase = "ended";
    }
  }

  // The owner adopted this result: a failed or reconciliation-uncertain generation keeps its bytes for the retry,
  // an acknowledged one releases them, and an uncertain attempt stays until reconciliation ends it.
  ended(result: CheckpointResult, reconciliation: boolean): void {
    const attempt = this.attempts.get(result.attemptId);
    if (attempt == null) return;
    const hold = () => {
      if (attempt.request != null && attempt.bytes != null)
        this.held.set(attempt.unit, { request: attempt.request, bytes: attempt.bytes, fileSynced: attempt.fileSynced });
      else this.held.delete(attempt.unit);
    };
    if (result.kind === "acknowledged") this.held.delete(attempt.unit);
    else if (result.kind === "failed" || reconciliation) hold();
    if (result.kind !== "uncertain") this.attempts.delete(result.attemptId);
  }

  // spec §5.7: re-check an uncertain attempt once the publisher grants the reconciliation.
  async reconcile(unit: UnitId, attemptId: string): Promise<Readonly<{ result: CheckpointResult; measurements: readonly CheckpointMeasurement[] }>> {
    const attempt = this.attempts.get(attemptId);
    if (attempt?.request == null || attempt.request.unit !== unit || attempt.phase !== "ended")
      throw new Error("checkpoint is not awaiting reconciliation");
    const identity = { attemptId, unit, generation: attempt.generation,
      encodedByteLength: attempt.request.encodedByteLength };
    attempt.phase = "running";
    const measurements: CheckpointMeasurement[] = [];
    let stage: "verify" | "directorySync" = "verify";
    let started = this.readClock().monotonicMs;
    const measure = (outcome: CheckpointMeasurement["outcome"]) => {
      measurements.push(this.measurement(attempt.request!, stage, started, this.readClock().monotonicMs,
        stage === "verify" ? attempt.request!.encodedByteLength : 0, outcome, attempt.runId, attempt));
    };
    try {
      const restored = this.restoreUnit(unit);
      if (!attempt.fileSynced || restored.kind !== "restored" || restored.envelope.generation !== attempt.generation
        || restored.envelope.sha256 !== attempt.request.envelope.sha256)
        throw new Error("uncertain checkpoint identity mismatch");
      measure("succeeded");
      stage = "directorySync";
      started = this.readClock().monotonicMs;
      await this.fileSystem.syncDirectory(this.directory);
      measure("succeeded");
      // The original write completed fileSync before rename. Reconfirm the directory entry.
      stage = "verify";
      started = this.readClock().monotonicMs;
      const verified = this.restoreUnit(unit);
      if (verified.kind !== "restored" || verified.envelope.sha256 !== attempt.request.envelope.sha256)
        throw new Error("uncertain checkpoint changed during reconciliation");
      measure("succeeded");
      attempt.acknowledged = true;
      return { result: { ...identity, kind: "acknowledged", ackAt: this.readClock().wallTimeMs }, measurements };
    } catch (error) {
      attempt.failedStage = stage;
      this.knowledge.delete(unit); // AC02(4): only a successful reconciliation keeps the memory restoreUnit just set.
      measure("failed");
      return { result: stage === "directorySync"
        ? { ...identity, kind: "uncertain", observedAt: this.readClock().wallTimeMs, stage }
        : { ...identity, kind: "failed", failedAt: this.readClock().wallTimeMs, stage, reason: errorMessage(error) }, measurements };
    } finally {
      attempt.phase = "ended";
    }
  }

  private codec(unit: UnitId): UnitCodec<unknown, JsonValue> | null {
    return (this.codecs as Readonly<Partial<Record<UnitId, UnitCodec<unknown, JsonValue>>>>)[unit] ?? null;
  }

  private measurement(request: CheckpointRequest, stage: CheckpointMeasurement["stage"],
    startedMonotonicMs: number, endedMonotonicMs: number, bytes: number,
    outcome: CheckpointMeasurement["outcome"], runId: string, correlation: Correlation): CheckpointMeasurement {
    return { runId, inputIds: [...correlation.inputIds], unit: request.unit, generation: request.generation,
      attemptId: request.attemptId, stage, startedMonotonicMs, endedMonotonicMs, bytes, outcome,
      retryReason: correlation.retryReason };
  }

  private slotPath(unit: UnitId, slot: Slot): string {
    return join(this.directory, `${unit}-${slot}.json`);
  }

  private removeTemporaries(unit: UnitId): void {
    // Exact owned paths only; old slot-specific tmp files never participate in restore.
    for (const name of [`${unit}.json.tmp`, `${unit}-A.json.tmp`, `${unit}-B.json.tmp`])
      this.fileSystem.unlinkSync(join(this.directory, name));
  }

  private readSlot(unit: UnitId, slot: Slot, codec: UnitCodec<unknown, JsonValue>): SlotRead | SlotInvalid {
    const bytes = this.fileSystem.readFile(this.slotPath(unit, slot));
    if (bytes == null) return "missing";
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "invalid";
    let text: string;
    try { text = decoder.decode(bytes); } catch { return "invalid"; }
    const match = text.match(/,"sha256":"([0-9a-f]{64})"}$/);
    if (match == null) return "invalid";
    const zeroed = bytes.slice();
    zeroed.fill(0x30, bytes.byteLength - 66, bytes.byteLength - 2);
    if (createHash("sha256").update(zeroed).digest("hex") !== match[1]) return "invalid";
    let value: unknown;
    try { value = JSON.parse(text); } catch { return "invalid"; }
    if (value == null || typeof value !== "object" || Array.isArray(value)) return "invalid";
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== codec.schemaVersion) return "unknownSchema";
    if (record.unit !== unit || !Number.isSafeInteger(record.generation) || Number(record.generation) < 1
      || typeof record.capturedAt !== "number" || !Number.isFinite(record.capturedAt)
      || record.sha256 !== match[1]) return "invalid";
    const envelope: CheckpointEnvelope = {
      schemaVersion: record.schemaVersion,
      unit,
      generation: Number(record.generation),
      capturedAt: record.capturedAt,
      payload: record.payload as JsonValue,
      sha256: match[1],
    };
    if (decoder.decode(serializedEnvelope(envelope)) !== text) return "invalid";
    try {
      const decoded = codec.decode(envelope.payload);
      return decoded.kind === "restored" ? { slot, envelope } : "invalid";
    } catch { return "invalid"; }
  }

  private restoreRejected(unit: UnitId, _reason: "noValidSlot" | "unknownSchema" | "conflictingGeneration"): void {
    const clock = this.readClock();
    this.emitDiagnostic(completeDiagnostic({ level: "ERROR", component: "checkpoint",
      reason: "checkpointRestoreRejected", unit }, clock, "restore"));
  }

}

// P3-C3A-WRITE-RIGHT (spec §5.8, spec:859): the publisher's side. One write right in the whole process, given to the
// oldest due dirty unit (fixed UnitId order on a tie), and the retry interval 1/2/4/8/10 s after an ended failure.
type CheckpointGrant = Readonly<{ grantId: string; unit: RuntimeUnitId; mode: "save" | "reconcile";
  retryReason: CheckpointMeasurement["retryReason"]; generation: number; grantedAtMonotonicMs: number; runId: string }>;

class CheckpointWriter {
  private readonly retry = new Map<UnitId, { failures: number; retryAfter: number; retryReason: CheckpointMeasurement["retryReason"] }>();
  private readonly overdue = new Map<UnitId, number>();
  // The generation an owner declined to save (nothing new, or its inputs are not all known): skipped until it changes.
  private readonly declined = new Map<UnitId, number>();
  private current: (CheckpointGrant & { monitored: boolean }) | null = null;
  private sequence = 0;

  constructor(
    private readonly saves: (unit: RuntimeUnitId) => boolean,
    private readonly emitDiagnostic: (event: DiagnosticEvent) => void,
  ) {}

  get grant(): CheckpointGrant | null { return this.current; }

  retryAfter(unit: UnitId): number | null {
    return this.retry.get(unit)?.retryAfter ?? null;
  }

  retryReason(unit: UnitId): CheckpointMeasurement["retryReason"] {
    return this.retry.get(unit)?.retryReason ?? "notRetry";
  }

  // The one "save is due now" test.
  saveDue(persistence: PersistenceStatus, unit: RuntimeUnitId, clock: ClockReading, force = false): boolean {
    return persistence.kind !== "uncertain" && persistence.dirtySince != null
      && persistence.currentGeneration !== persistence.savedGeneration && this.saves(unit)
      && this.declined.get(unit) !== persistence.currentGeneration
      && (force || (this.retry.get(unit)?.retryAfter ?? Number.NEGATIVE_INFINITY) <= clock.monotonicMs);
  }

  // Overdue (3 s) and the 10 s monitor of a held right are reported here; at most one grant is outstanding.
  next(persistence: Readonly<Record<RuntimeUnitId, PersistenceStatus>>, clock: ClockReading, runId: string,
    options: Readonly<{ force?: boolean; reconcile?: boolean; excluded?: ReadonlySet<UnitId> }> = {}): CheckpointGrant | null {
    for (const unit of runtimeUnits) {
      const status = persistence[unit];
      if (status.dirtySince != null && clock.monotonicMs - status.dirtySince > 3_000) this.emitOverdue(unit, status.currentGeneration, runId, clock);
    }
    if (this.current != null) {
      const held = this.current;
      if (!held.monitored && clock.monotonicMs - held.grantedAtMonotonicMs >= 10_000) {
        held.monitored = true;
        this.emitDiagnostic(completeDiagnostic({ level: "WARN", component: "checkpoint",
          reason: "checkpointUncertain", unit: held.unit, generation: held.generation,
          attemptId: held.grantId, durationMs: clock.monotonicMs - held.grantedAtMonotonicMs }, clock, held.runId));
      }
      return null;
    }
    const excluded = options.excluded ?? new Set<UnitId>();
    let selected: Readonly<{ unit: RuntimeUnitId; mode: "save" | "reconcile"; generation: number }> | null = null;
    // An uncertain unit is never a save candidate: reconcile it on every due tick until it is acknowledged.
    if (options.reconcile !== false) for (const unit of runtimeUnits) {
      const status = persistence[unit];
      if (excluded.has(unit) || status.kind !== "uncertain"
        || clock.monotonicMs < (this.retry.get(unit)?.retryAfter ?? -Infinity)) continue;
      selected = { unit, mode: "reconcile", generation: status.attemptedGeneration };
      break;
    }
    if (selected == null) {
      const candidates = runtimeUnits.filter((unit) => !excluded.has(unit) && this.saveDue(persistence[unit], unit, clock, options.force))
        .sort((left, right) => persistence[left].dirtySince! - persistence[right].dirtySince! || left.localeCompare(right));
      const unit = candidates[0];
      if (unit != null) selected = { unit, mode: "save", generation: persistence[unit].currentGeneration };
    }
    if (selected == null) return null;
    this.current = { ...selected, grantId: `${runId}:grant:${++this.sequence}`, retryReason: this.retryReason(selected.unit),
      grantedAtMonotonicMs: clock.monotonicMs, runId, monitored: false };
    return this.current;
  }

  // The write right is released only by the reply to the current grant; any other reply changes nothing here.
  // previous: the unit's persistence before the reply was applied. Returns false for a reply that is not the current grant.
  done(grantId: string, unit: UnitId, result: CheckpointResult | null, measurements: readonly CheckpointMeasurement[],
    previous: PersistenceStatus, clock: ClockReading): boolean {
    const grant = this.current;
    if (grant == null || grant.grantId !== grantId || grant.unit !== unit) return false;
    this.current = null;
    if (result == null) {
      this.declined.set(grant.unit, grant.generation);
      return true;
    }
    const diagnostics: DiagnosticEvent[] = [];
    const failedStage = [...measurements].reverse().find((item) => item.outcome === "failed")?.stage ?? null;
    if (grant.mode === "reconcile" && result.kind !== "acknowledged")
      diagnostics.push(this.scheduleRetry(grant, result, clock, "ackUncertain"));
    if (result.kind === "acknowledged") {
      this.retry.delete(result.unit);
      this.overdue.delete(result.unit);
    } else if (result.kind === "failed") {
      diagnostics.push(completeDiagnostic({ level: "ERROR", component: "checkpoint",
        reason: failureReasons[result.stage], unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, grant.runId));
      if (grant.mode === "save") diagnostics.push(this.scheduleRetry(grant, result, clock,
        previous.kind === "uncertain" ? "ackUncertain" : "saveFailed"));
    } else {
      const stage = failedStage ?? (result.stage === "ack" ? null : result.stage);
      if (stage != null && stage !== "encode") diagnostics.push(completeDiagnostic({ level: "ERROR", component: "checkpoint",
        reason: failureReasons[stage], unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, grant.runId));
      diagnostics.push(completeDiagnostic({ level: "WARN", component: "checkpoint",
        reason: "checkpointUncertain", unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, grant.runId));
    }
    diagnostics.forEach(this.emitDiagnostic);
    return true;
  }

  private scheduleRetry(grant: CheckpointGrant, result: CheckpointResult, clock: ClockReading,
    retryReason: CheckpointMeasurement["retryReason"]): DiagnosticEvent {
    const failures = (this.retry.get(grant.unit)?.failures ?? 0) + 1;
    const delay = retryDelays[Math.min(failures - 1, retryDelays.length - 1)];
    this.retry.set(grant.unit, { failures, retryAfter: clock.monotonicMs + delay, retryReason });
    return completeDiagnostic({ level: "WARN", component: "checkpoint", reason: "checkpointRetryScheduled",
      unit: grant.unit, generation: result.generation, attemptId: result.attemptId, durationMs: delay, count: failures }, clock, grant.runId);
  }

  private emitOverdue(unit: UnitId, generation: number, runId: string, clock: ClockReading): void {
    if (this.overdue.get(unit) === generation) return;
    this.overdue.set(unit, generation);
    this.emitDiagnostic(completeDiagnostic({ level: "WARN", component: "checkpoint",
      reason: "checkpointOverdue", unit, generation }, clock, runId));
  }
}

export { CheckpointCoordinator, CheckpointWriter, hashEnvelope, serializedEnvelope };
export type { CheckpointFileSystem, CheckpointGrant, CodecMap, Correlation, WritableCheckpoint };
