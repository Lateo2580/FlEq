import { resolve } from "node:path";

import type { ParserMailboxResult, ProcessingMarks } from "../../contracts/p1-parser-boundary.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  OwnerOutput, OwnerReply, OwnerRequest, OwnerStartData, OwnerUnitDelta, SentClock,
} from "../../contracts/p3-execution-split.types";
import type {
  CheckpointResult, ClockReading, DiagnosticEvent, NotificationIntent, RestoreUnitResult, RuntimeUnitId,
  RuntimeUnitStates, RuntimeUnitView,
} from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap } from "../checkpoint/checkpoint";
import { decodeMaterial } from "../decode-material/decode-material";
import {
  capturedOwner, checkpointResultOwner, deadlineOwner, finalizeOwner, intentUpdateOwner, ownerViews, placeUnits,
  receiveOwner, restoreOwner, shutdownInputOwner, unitAdmissionCounts,
} from "./owner-runtime";
import type { OwnerState, OwnerStep } from "./owner-runtime";

type OwnerHostOptions = Readonly<{
  start: OwnerStartData;
  units: UnitTable;
  codecs: CodecMap<RuntimeUnitStates>;
  fileSystem: CheckpointFileSystem;
  // performance.timeOrigin + performance.now(): the real clock every thread shares (P3-C3A-CLOCK).
  sharedNow: () => number;
  reply: (reply: OwnerReply) => void;
  // An invariant broken after an asynchronous checkpoint operation (the request itself already returned).
  fail: (error: unknown) => void;
}>;

const noMarks: ProcessingMarks = { ingressJsonMs: null, base64DecodeMs: null, decompressionMs: null, fullXmlParseMs: null,
  metadataSpecialValueMs: null, domainExtractionMs: null, workerTransferMs: null };

// One owner: the canonical state of its place's units, applied one request at a time in arrival order (spec:676).
// The owner thread runs one; the test path (2) runs one per place in-process. Values cross only as OwnerReply.
class OwnerHost {
  private state: OwnerState | null = null;
  private coordinator: CheckpointCoordinator | null = null;
  private readonly own: readonly RuntimeUnitId[];
  // P2-A3-AC10: per unit, the input IDs of each unsaved generation (null = unknown).
  private readonly ledger: Partial<Record<RuntimeUnitId, Map<number, readonly string[] | null>>> = {};
  private readonly unavailable = new Set<RuntimeUnitId>();
  // The intents array each unit last reported; pendingIntents is sent only when it changed.
  private readonly reported: Partial<Record<RuntimeUnitId, readonly NotificationIntent[]>> = {};
  private readonly diagnostics: DiagnosticEvent[] = [];
  private base: SentClock | null = null;

  constructor(private readonly options: OwnerHostOptions) {
    this.own = placeUnits(options.start.place);
  }

  // Made by the restore request: its startup clean-up of owned tmp files may report a diagnostic, which needs that
  // request's clock (an owner has no clock before its first request).
  private get checkpoint(): CheckpointCoordinator {
    if (this.coordinator == null) throw new Error("owner has not restored");
    return this.coordinator;
  }

  handle(request: OwnerRequest): void {
    this.base = { clock: request.clock, sharedMs: request.sharedMs };
    if (request.kind === "restore") { this.restore(request.runId); return; }
    const state = this.state;
    if (state == null) throw new Error("owner has not restored");
    if (state.finalized && request.kind !== "checkpointGrant") throw new Error("owner is finalized");
    switch (request.kind) {
      case "input": {
        const started = this.business();
        const processingStartedMs = this.measured();
        const { envelope } = request;
        const { item } = envelope.payload;
        const decodeStarted = this.measured();
        const result: ParserMailboxResult = decodeMaterial(item);
        const decodeEnded = this.measured();
        const clock = this.business();
        const step = this.apply(receiveOwner(state, { runId: envelope.runId, inputId: item.inputId, result }, clock, this.options.units));
        const marks = result.kind === "decoded" ? result.material.marks : noMarks;
        this.options.reply({ kind: "inputDone", settlement: { kind: "parser", messageId: envelope.messageId,
          runId: envelope.runId, encodedByteLength: item.encodedByteLength, startedMonotonicMs: started.monotonicMs,
          completedMonotonicMs: clock.monotonicMs, inputId: item.inputId, inputSequence: item.inputSequence },
        processingStartedMs, marks: { ...marks, ingressJsonMs: null,
          workerTransferMs: processingStartedMs - (request.sharedMs - this.options.start.publisherTimeOriginMs) },
        decode: { startedMonotonicMs: decodeStarted, endedMonotonicMs: decodeEnded }, output: this.output([step]) });
        return;
      }
      case "deadline": {
        const step = this.apply(deadlineOwner(state, this.business(), this.options.units));
        this.options.reply({ kind: "deadlineDone", output: this.output([step]) });
        return;
      }
      case "intentUpdate": {
        const step = intentUpdateOwner(state, request.unit, request.updates, request.decisionClock, this.options.units);
        this.apply(step);
        this.options.reply({ kind: "intentUpdateDone", requestId: request.requestId, adopted: step.adopted, output: this.output([step]) });
        return;
      }
      case "checkpointGrant": this.grant(request); return;
      case "shutdownInput": {
        const step = this.apply(shutdownInputOwner(state, this.business(), this.options.units));
        this.options.reply({ kind: "shutdownInputDone", output: this.output([step]) });
        return;
      }
      case "finalize": {
        const step = this.apply(finalizeOwner(state, request.cutoff, this.options.units));
        this.options.reply({ kind: "finalizeDone", appliedThrough: request.cutoff, output: this.output([step]) });
        return;
      }
      default: { const unknown: never = request; throw new Error(`unknown owner request ${String(unknown)}`); }
    }
  }

  // Business time: the publisher's injected clock at post plus the real time since (P3-C3A-CLOCK A).
  private business(): ClockReading {
    if (this.base == null) throw new Error("owner has no request clock");
    const elapsed = this.options.sharedNow() - this.base.sharedMs;
    return { wallTimeMs: this.base.clock.wallTimeMs + elapsed, monotonicMs: this.base.clock.monotonicMs + elapsed };
  }

  // Measured time: the publisher's real monotonic clock, with no injected offset (P2-A10-AC03).
  private measured(): number {
    return this.options.sharedNow() - this.options.start.publisherTimeOriginMs;
  }

  private restore(runId: string): void {
    if (this.state != null) throw new Error("owner already restored");
    const clock = this.business();
    const { codecs, fileSystem, start } = this.options;
    // As validateAppConfig did for the single-thread root: slots live under the absolute state directory.
    this.coordinator = new CheckpointCoordinator(resolve(start.stateDirectory),
      Object.fromEntries(this.own.flatMap((unit) => codecs[unit] == null ? [] : [[unit, codecs[unit]]])), fileSystem,
      () => ({ wallTimeMs: this.business().wallTimeMs, monotonicMs: this.measured() }),
      (event) => { this.diagnostics.push(event); });
    const restored: Partial<Record<RuntimeUnitId, RestoreUnitResult>> = {};
    for (const unit of this.own) restored[unit] = this.checkpoint.restoreUnit(unit);
    const first = restoreOwner({ runId, place: this.options.start.place, clock, restored }, this.options.units, this.options.codecs);
    const deadline = deadlineOwner(first.state, clock, this.options.units);
    this.state = deadline.state;
    for (const unit of this.own) {
      const entry = restored[unit]!;
      if (first.restoration[unit]?.kind === "unavailable") this.unavailable.add(unit);
      const base = entry.kind === "restored" ? entry.envelope.generation : 0;
      const ids = { ...first.generationInputIds, ...deadline.generationInputIds };
      const current = this.persistence(unit).currentGeneration;
      for (let generation = base + 1; generation <= current; generation++)
        (this.ledger[unit] ??= new Map()).set(generation, Object.hasOwn(ids, unit) ? ids[unit]! : null);
    }
    const views = new Map(ownerViews(this.state, this.options.units).map((view) => [view.unit, view]));
    const output = this.output([first, deadline]);
    this.options.reply({ kind: "restored", output, units: this.own.map((unit) => ({ ...this.delta(unit, views.get(unit)!),
      view: views.get(unit)!, pendingIntents: this.pending(unit),
      restoration: first.restoration[unit]! })) });
  }

  private grant(request: Extract<OwnerRequest, { kind: "checkpointGrant" }>): void {
    const state = this.state!;
    const { unit, grantId } = request;
    const done = (result: CheckpointResult | null, measurements: readonly CheckpointMeasurement[], steps: readonly OwnerStep[]) =>
      this.options.reply({ kind: "checkpointDone", grantId, unit, result, measurements, output: this.output(steps) });
    const persistence = state.units[unit]?.persistence;
    if (request.mode === "reconcile") {
      const attempt = state.checkpointAttempts[unit];
      if (persistence?.kind !== "uncertain" || attempt == null) { done(null, [], []); return; }
      this.checkpoint.reconcile(unit, attempt.attemptId).then(({ result, measurements }) => {
        const step = this.apply(checkpointResultOwner(this.state!, result, this.options.units));
        this.checkpoint.ended(result, true);
        done(result, measurements, [step]);
      }).catch(this.options.fail);
      return;
    }
    const inputIds = this.inputIds(unit);
    if (persistence == null || persistence.kind === "uncertain" || persistence.dirtySince == null
      || persistence.currentGeneration === persistence.savedGeneration || !this.checkpoint.saves(unit) || inputIds == null) {
      done(null, [], []);
      return;
    }
    // The publisher holds one write right (RES-03): a second save of a unit whose attempt is still open is a broken invariant.
    if (state.checkpointAttempts[unit] != null) throw new Error(`a save of ${unit} is already in progress`);
    const correlation = { inputIds, retryReason: request.retryReason };
    const scheduled = this.checkpoint.capture(unit, state.units[unit], persistence.currentGeneration, state.runId, correlation);
    const captured = this.apply(capturedOwner(state, scheduled.capture, this.options.units));
    if (scheduled.request == null) {
      const step = this.apply(checkpointResultOwner(this.state!, scheduled.result, this.options.units));
      this.checkpoint.ended(scheduled.result, false);
      done(scheduled.result, scheduled.measurements, [captured, step]);
      return;
    }
    this.checkpoint.executeCheckpoint(scheduled.request, state.runId, inputIds, request.retryReason).then((executed) => {
      // The result is one more input of this owner, applied to the state current at that time (P3-C3A-CHECKPOINT-ACK).
      const step = this.apply(checkpointResultOwner(this.state!, executed.result, this.options.units));
      this.checkpoint.ended(executed.result, false);
      done(executed.result, [...scheduled.measurements, ...executed.measurements], [captured, step]);
    }).catch(this.options.fail);
  }

  private persistence(unit: RuntimeUnitId) {
    const value = this.state?.units[unit];
    if (value == null) throw new Error(`unit ${unit} is not owned here`);
    return value.persistence;
  }

  // Adopts a step and keeps the generation ledger whole across it (P2-A3-AC10): a save's input IDs come from here.
  private apply<S extends OwnerStep>(step: S): S {
    const before = this.state!;
    for (const unit of this.own) {
      const previous = before.units[unit]?.persistence;
      const next = step.state.units[unit]?.persistence;
      if (previous == null || next == null) continue;
      if (next.currentGeneration > previous.currentGeneration || (next.savedGeneration ?? 0) > (previous.savedGeneration ?? 0)) {
        const ledger = this.ledger[unit] ??= new Map();
        for (let generation = previous.currentGeneration + 1; generation <= next.currentGeneration; generation++)
          ledger.set(generation, Object.hasOwn(step.generationInputIds, unit) ? step.generationInputIds[unit]! : null);
        // Keys stay above the saved generation, so only the newly saved range leaves the ledger.
        for (let generation = (previous.savedGeneration ?? 0) + 1; generation <= (next.savedGeneration ?? 0); generation++)
          ledger.delete(generation);
      }
    }
    this.state = step.state;
    return step;
  }

  private inputIds(unit: RuntimeUnitId): readonly string[] | null {
    const { currentGeneration, savedGeneration } = this.persistence(unit);
    const ledger = this.ledger[unit];
    if (this.unavailable.has(unit) || ledger == null) return null;
    const ids = new Set<string>();
    for (let generation = (savedGeneration ?? 0) + 1; generation <= currentGeneration; generation++) {
      const value = ledger.get(generation);
      if (value == null) return null;
      for (const id of value) ids.add(id);
    }
    return [...ids];
  }

  private pending(unit: RuntimeUnitId): readonly NotificationIntent[] {
    const intents = this.state!.units[unit]!.intents;
    this.reported[unit] = intents;
    return intents.filter((intent) => intent.disposition === "pending");
  }

  private delta(unit: RuntimeUnitId, view: RuntimeUnitView | null): OwnerUnitDelta {
    const state = this.state!;
    return { unit, persistence: this.persistence(unit), admissionCounts: unitAdmissionCounts(state.admission, unit), view,
      pendingIntents: state.units[unit]!.intents === this.reported[unit] ? null : this.pending(unit) };
  }

  private output(steps: readonly OwnerStep[]): OwnerOutput {
    const views = new Map<RuntimeUnitId, RuntimeUnitView>();
    const changed: RuntimeUnitId[] = [];
    for (const step of steps) {
      for (const unit of step.changedUnits) if (!changed.includes(unit)) changed.push(unit);
      for (const view of step.views) {
        views.set(view.unit, view);
        if (!changed.includes(view.unit)) changed.push(view.unit);
      }
    }
    return {
      units: changed.map((unit) => this.delta(unit, views.get(unit) ?? null)),
      outcomes: steps.flatMap((step) => step.outcomes),
      displayChanges: steps.flatMap((step) => step.displayChanges),
      confirmationEvidence: steps.flatMap((step) => step.confirmationEvidence),
      retiredEvents: steps.flatMap((step) => step.retiredEvents),
      diagnostics: [...this.diagnostics.splice(0), ...steps.flatMap((step) => step.diagnostics)],
    };
  }
}

export { OwnerHost };
export type { OwnerHostOptions };
