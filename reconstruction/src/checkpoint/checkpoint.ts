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
  RestoreUnitResult,
  RuntimeState,
  RuntimeUnitStates,
  RuntimeUnitId,
  UnitCodec,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { completeDiagnostic } from "../runtime/runtime-diagnostic";

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
  monitored?: boolean;
  failedStage?: CheckpointMeasurement["stage"];
  renamed?: boolean;
  fileSynced?: boolean;
  acknowledged?: boolean;
  retryRecorded?: boolean;
};

type Slot = "A" | "B";
type SlotRead = Readonly<{ slot: Slot; envelope: CheckpointEnvelope; state: unknown }>;
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

function hashEnvelope(envelope: Omit<CheckpointEnvelope, "sha256">): CheckpointEnvelope {
  const sha256 = createHash("sha256").update(envelopeBytes(envelope)).digest("hex");
  return { ...envelope, sha256 };
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

class CheckpointCoordinator<UnitStates extends RuntimeUnitStates = RuntimeUnitStates> {
  private readonly attempts = new Map<string, Attempt>();
  private readonly retry = new Map<UnitId, { failures: number; retryAfter: number;
    retryReason: CheckpointMeasurement["retryReason"] }>();
  private readonly restored = new Map<UnitId, unknown>();
  private readonly overdue = new Map<UnitId, number>();
  private reservedAttemptId: string | null = null;
  private attemptSequence = 0;

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
    this.restored.delete(unit);
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
    this.restored.set(unit, selected.state);
    return { kind: "restored", envelope: selected.envelope, slot: selected.slot };
  }

  restoredState(unit: UnitId): unknown | null {
    return this.restored.get(unit) ?? null;
  }

  scheduleCheckpoint(
    state: RuntimeState<UnitStates>,
    clock: ClockReading,
    runId: string,
    correlationByUnit: Readonly<Partial<Record<UnitId, Correlation>>>,
    force = false,
    excluded: ReadonlySet<UnitId> = new Set(),
  ): Readonly<{ capture: CheckpointCapture; request: CheckpointRequest; result: null; measurements: readonly CheckpointMeasurement[] }>
    | Readonly<{ capture: CheckpointCapture; request: null; result: Extract<CheckpointResult, { kind: "failed" }> & Readonly<{ stage: "encode" }>; measurements: readonly CheckpointMeasurement[] }>
    | null {
    for (const [unit, status] of Object.entries(state.persistence) as [UnitId, RuntimeState<UnitStates>["persistence"][UnitId]][]) {
      if (status?.dirtySince != null && clock.monotonicMs - status.dirtySince > 3_000) this.emitOverdue(unit, status.currentGeneration, runId, clock);
    }
    if (this.reservedAttemptId != null) {
      const attempt = this.attempts.get(this.reservedAttemptId)!;
      if (!attempt.monitored && attempt.request != null
        && clock.monotonicMs - attempt.request.reservedAt >= 10_000) {
        attempt.monitored = true;
        this.emitDiagnostic(completeDiagnostic({ level: "WARN", component: "checkpoint",
          reason: "checkpointUncertain", unit: attempt.unit, generation: attempt.generation,
          attemptId: attempt.request.attemptId, durationMs: clock.monotonicMs - attempt.request.reservedAt }, clock, attempt.runId));
      }
      return null;
    }
    const candidates = (["U-E", "U-W", "U-F"] as const).map((unit) => [unit, state.persistence[unit]] as const)
      .filter(([unit, status]) => status != null && !excluded.has(unit)
        && status.kind !== "uncertain" && status.dirtySince != null
        && status.currentGeneration !== status.savedGeneration
        && this.codec(unit) != null
        && correlationByUnit[unit] != null
        && correlationByUnit[unit]!.retryReason === (this.retry.get(unit)?.retryReason ?? "notRetry")
        && (force || (this.retry.get(unit)?.retryAfter ?? Number.NEGATIVE_INFINITY) <= clock.monotonicMs))
      .sort(([leftUnit, left], [rightUnit, right]) =>
        left!.dirtySince! - right!.dirtySince! || leftUnit.localeCompare(rightUnit));
    const selected = candidates[0];
    if (selected == null) return null;
    const [unit, status] = selected;
    const codec = this.codec(unit)!;
    const correlation = correlationByUnit[unit]!;
    const generation = status!.currentGeneration;
    const attemptId = `${runId}:${unit}:${generation}:${++this.attemptSequence}`;
    this.reservedAttemptId = attemptId;
    const started = this.readClock();
    const capturedAt = started.wallTimeMs;
    const capture: CheckpointCapture = { attemptId, unit, generation, capturedAt };
    try {
      const payload = codec.encode(state.units[unit]);
      const envelope = hashEnvelope({ schemaVersion: codec.schemaVersion, unit, generation, capturedAt, payload });
      const bytes = serializedEnvelope(envelope);
      const ended = this.readClock();
      const request: CheckpointRequest = {
        attemptId, unit, generation, reservedAt: clock.monotonicMs, capturedAt,
        envelope, encodedByteLength: bytes.byteLength,
      };
      this.attempts.set(attemptId, { request, unit, generation, runId, inputIds: [...correlation.inputIds],
        retryReason: correlation.retryReason, capturedAt, phase: "reserved" });
      return { capture, request, result: null, measurements: [this.measurement(request, "encode", started.monotonicMs,
        ended.monotonicMs, bytes.byteLength, "succeeded", runId, correlation)] };
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
      || attempt.request.envelope.sha256 !== request.envelope.sha256
      || attempt.request.encodedByteLength !== request.encodedByteLength || attempt.runId !== runId
      || attempt.retryReason !== retryReason || !sameStrings(attempt.inputIds, inputIds))
      throw new Error("checkpoint correlation mismatch");
    if (this.reservedAttemptId !== request.attemptId) throw new Error("checkpoint writer is not reserved");
    if (attempt.phase !== "reserved") throw new Error("checkpoint attempt already executed");
    attempt.phase = "running";

    const measurements: CheckpointMeasurement[] = [];
    const byteLength = request.encodedByteLength;
    let writable: WritableCheckpoint | null = null;
    let stage: CheckpointMeasurement["stage"] = "write";
    let stageStarted = this.readClock().monotonicMs;
    try {
      // Ownership is held until this attempt (including close cleanup) has ended.
      this.removeTemporaries(request.unit);
      const bytes = serializedEnvelope(request.envelope);
      const codec = this.codec(request.unit);
      if (codec == null) throw new Error("checkpoint codec unavailable");
      const latest = this.latestValidSlot(request.unit, codec);
      const slot: Slot = latest?.envelope.generation === request.generation
        ? latest.slot : latest?.slot === "A" ? "B" : "A";
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

      stage = "verify";
      started = stageStarted = this.readClock().monotonicMs;
      const verified = this.readSlot(request.unit, slot, codec);
      if (typeof verified === "string" || verified.envelope.sha256 !== request.envelope.sha256)
        throw new Error("written checkpoint did not verify");
      ended = this.readClock().monotonicMs;
      measurements.push(this.measurement(request, stage, started, ended, bytes.byteLength, "succeeded", runId, attempt));
      attempt.acknowledged = true;
      return { result: { kind: "acknowledged", attemptId: request.attemptId, unit: request.unit,
        generation: request.generation, ackAt: this.readClock().wallTimeMs, encodedByteLength: bytes.byteLength }, measurements };
    } catch (error) {
      attempt.failedStage = stage;
      if (writable != null) try { await writable.close(); } catch { /* the original stage owns the result */ }
      const now = this.readClock();
      measurements.push(this.measurement(request, stage, stageStarted, now.monotonicMs,
        stage === "write" || stage === "verify" ? byteLength : 0, "failed", runId, attempt));
      return { result: attempt.renamed || stage === "rename"
        ? { kind: "uncertain", attemptId: request.attemptId, unit: request.unit, generation: request.generation,
            observedAt: now.wallTimeMs, stage: stage === "verify" ? "ack" : stage as "rename" | "directorySync", encodedByteLength: byteLength }
        : { kind: "failed", attemptId: request.attemptId, unit: request.unit, generation: request.generation,
            failedAt: now.wallTimeMs, stage, reason: errorMessage(error), encodedByteLength: byteLength }, measurements };
    } finally {
      attempt.phase = "ended";
    }
  }

  validateResult(state: RuntimeState<UnitStates>, result: CheckpointResult): boolean {
    const previous = state.persistence[result.unit];
    const attempt = this.attempts.get(result.attemptId);
    if (previous == null || attempt == null) return false;
    if (attempt.unit !== result.unit || attempt.generation !== result.generation)
      throw new Error("checkpoint result correlation mismatch");
    const capture = state.checkpointAttempts[result.unit as RuntimeUnitId];
    if (capture?.attemptId !== result.attemptId || capture.generation !== result.generation
      || result.encodedByteLength !== (attempt.request?.encodedByteLength ?? 0))
      throw new Error("checkpoint capture correlation mismatch");
    if (result.kind !== "uncertain" && attempt.phase !== "ended")
      throw new Error("checkpoint operation has not ended");
    if (result.kind === "acknowledged" && !attempt.acknowledged)
      throw new Error("checkpoint durability is not confirmed");
    return true;
  }

  resultMetadata(state: RuntimeState<UnitStates>, result: CheckpointResult, clock: ClockReading): void {
    // Called only after validateResult and successful A1 adoption, with the pre-result state.
    const previous = state.persistence[result.unit]!;
    const attempt = this.attempts.get(result.attemptId)!;
    const diagnostics: DiagnosticEvent[] = [];
    if (result.kind === "acknowledged") {
      this.retry.delete(result.unit);
      this.overdue.delete(result.unit);
    } else if (result.kind === "failed") {
      diagnostics.push(completeDiagnostic({ level: "ERROR", component: "checkpoint",
        reason: failureReasons[result.stage], unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, attempt.runId));
      if (!attempt.retryRecorded) diagnostics.push(this.scheduleRetry(result.attemptId, attempt, clock,
        previous.kind === "uncertain" ? "ackUncertain" : "saveFailed"));
    } else {
      const failedStage = attempt.failedStage ?? (result.stage === "ack" ? null : result.stage);
      if (failedStage != null) diagnostics.push(completeDiagnostic({ level: "ERROR", component: "checkpoint",
        reason: failureReasons[failedStage], unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, attempt.runId));
      diagnostics.push(completeDiagnostic({ level: "WARN", component: "checkpoint",
        reason: "checkpointUncertain", unit: result.unit, generation: result.generation,
        attemptId: result.attemptId }, clock, attempt.runId));
    }
    if (this.reservedAttemptId === result.attemptId && attempt.phase === "ended") this.reservedAttemptId = null;
    diagnostics.forEach(this.emitDiagnostic);
    if (result.kind !== "uncertain") this.attempts.delete(result.attemptId);
  }

  retryAfter(unit: UnitId): number | null {
    return this.retry.get(unit)?.retryAfter ?? null;
  }

  retryReason(unit: UnitId): CheckpointMeasurement["retryReason"] {
    return this.retry.get(unit)?.retryReason ?? "notRetry";
  }

  async resolveUncertain(state: RuntimeState<UnitStates>, unit: UnitId, attemptId: string,
    clock: ClockReading): Promise<Readonly<{ result: CheckpointResult | null; measurements: readonly CheckpointMeasurement[] }>> {
    const attempt = this.attempts.get(attemptId);
    const previous = state.persistence[unit];
    if (attempt?.request == null || previous?.kind !== "uncertain"
      || attempt.request.unit !== unit || previous.attemptedGeneration !== attempt.request.generation)
      throw new Error("checkpoint is not awaiting reconciliation");
    const identity = { attemptId, unit, generation: attempt.generation,
      encodedByteLength: attempt.request.encodedByteLength };
    if (attempt.phase !== "ended" || this.reservedAttemptId != null && this.reservedAttemptId !== attemptId
      || clock.monotonicMs < (this.retry.get(unit)?.retryAfter ?? -Infinity))
      return { result: null, measurements: [] };
    this.reservedAttemptId = attemptId;
    attempt.phase = "running";
    attempt.retryRecorded = false;
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
      measure("failed");
      this.emitDiagnostic(this.scheduleRetry(attemptId, attempt, this.readClock(), "ackUncertain"));
      return { result: stage === "directorySync"
        ? { ...identity, kind: "uncertain", observedAt: this.readClock().wallTimeMs, stage }
        : { ...identity, kind: "failed", failedAt: this.readClock().wallTimeMs, stage, reason: errorMessage(error) }, measurements };
    } finally {
      attempt.phase = "ended";
    }
  }

  private scheduleRetry(attemptId: string, attempt: Attempt, clock: ClockReading,
    retryReason: CheckpointMeasurement["retryReason"]): DiagnosticEvent {
    const failures = (this.retry.get(attempt.unit)?.failures ?? 0) + 1;
    const delay = retryDelays[Math.min(failures - 1, retryDelays.length - 1)];
    this.retry.set(attempt.unit, { failures, retryAfter: clock.monotonicMs + delay, retryReason });
    attempt.retryRecorded = true;
    return completeDiagnostic({ level: "WARN", component: "checkpoint", reason: "checkpointRetryScheduled",
      unit: attempt.unit, generation: attempt.generation, attemptId, durationMs: delay, count: failures }, clock, attempt.runId);
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

  private latestValidSlot(unit: UnitId, codec: UnitCodec<unknown, JsonValue>): SlotRead | null {
    return (["A", "B"] as const).map((slot) => this.readSlot(unit, slot, codec))
      .filter((value): value is SlotRead => typeof value !== "string")
      .reduce<SlotRead | null>((latest, value) => latest == null || value.envelope.generation > latest.envelope.generation ? value : latest, null);
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
      return decoded.kind === "restored" ? { slot, envelope, state: decoded.state } : "invalid";
    } catch { return "invalid"; }
  }

  private restoreRejected(unit: UnitId, _reason: "noValidSlot" | "unknownSchema" | "conflictingGeneration"): void {
    const clock = this.readClock();
    this.emitDiagnostic(completeDiagnostic({ level: "ERROR", component: "checkpoint",
      reason: "checkpointRestoreRejected", unit }, clock, "restore"));
  }

  private emitOverdue(unit: UnitId, generation: number, runId: string, clock: ClockReading): void {
    if (this.overdue.get(unit) === generation) return;
    this.overdue.set(unit, generation);
    this.emitDiagnostic(completeDiagnostic({ level: "WARN", component: "checkpoint",
      reason: "checkpointOverdue", unit, generation }, clock, runId));
  }
}

export { CheckpointCoordinator, hashEnvelope, serializedEnvelope };
export type { CheckpointFileSystem, CodecMap, Correlation, WritableCheckpoint };
