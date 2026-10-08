import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { ParserMailboxResult, ProcessingMarks } from "../../contracts/p1-parser-boundary.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  OwnerHeap, OwnerOutput, OwnerReply, OwnerRequest, OwnerStartData, OwnerUnitDelta, SentClock,
} from "../../contracts/p3-execution-split.types";
import type {
  CheckpointResult, ClockReading, DiagnosticEvent, NotificationIntent, RestoreUnitResult, RuntimeUnitId,
  RuntimeUnitStates, RuntimeUnitView,
} from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap } from "../checkpoint/checkpoint";
import { decodeMaterial } from "../decode-material/decode-material";
import { countedCheckpointFileSystem, writeCounters } from "./composition-root";
import type { WriteCounters } from "./composition-root";
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
// P3-C4-OWNER-HEAP=B': この thread の heap（印があるときだけ呼ぶ）。
function threadHeap(): OwnerHeap {
  const { heapUsed, external } = process.memoryUsage();
  return { heapUsedBytes: heapUsed, externalBytes: external };
}

const ledgerLimit = 4096;

class OwnerHost {
  private state: OwnerState | null = null;
  private coordinator: CheckpointCoordinator | null = null;
  private readonly own: readonly RuntimeUnitId[];
  // P2-A3-AC10: per unit, the input IDs of each unsaved generation (null = unknown).
  // P3-OLB-AC01: unit ごとに 4,096 世代まで。無いと I/O が止まっている間、記録が世代ごとに伸び続ける。
  private readonly ledger: Partial<Record<RuntimeUnitId, Map<number, readonly string[]>>> = {};
  // その run では保存しない unit: 復元が unavailable だったものと、帰属不明の世代を記録したもの（P3-OLB-AC02。
  // 不明を項目で持つと上限で捨てたとき不明が消え、P2-A3-AC10 が拒む capture を通してしまう）。
  private readonly unavailable = new Set<RuntimeUnitId>();
  // The intents array each unit last reported; pendingIntents is sent only when it changed.
  private readonly reported: Partial<Record<RuntimeUnitId, readonly NotificationIntent[]>> = {};
  private readonly diagnostics: DiagnosticEvent[] = [];
  private base: SentClock | null = null;
  // P3-C4-WRITE-COUNT: 測定の印があるときだけ、注入された filesystem を数える包みで使う（印が無ければ包みも counter も作らない）。
  private readonly writeCounts: WriteCounters | null;
  private readonly fileSystem: CheckpointFileSystem;

  constructor(private readonly options: OwnerHostOptions) {
    this.own = placeUnits(options.start.place);
    this.writeCounts = options.start.measured ? writeCounters() : null;
    this.fileSystem = this.writeCounts == null ? options.fileSystem : countedCheckpointFileSystem(options.fileSystem, this.writeCounts);
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
        const parseTimes: { startedMs: number | null; endedMs: number | null } | undefined =
          this.options.start.measured ? { startedMs: null, endedMs: null } : undefined;
        const decodeStarted = this.measured();
        const result: ParserMailboxResult = decodeMaterial(item, parseTimes);
        const decodeEnded = this.measured();
        const clock = this.business();
        let generationRaisedMs: number | null = null;
        const step = this.apply(receiveOwner(state, { runId: envelope.runId, inputId: item.inputId, result }, clock, this.options.units,
          this.options.start.measured ? () => { generationRaisedMs = this.measured(); } : undefined));
        const marks = result.kind === "decoded" ? result.material.marks : noMarks;
        this.options.reply({ kind: "inputDone", settlement: { kind: "parser", messageId: envelope.messageId,
          runId: envelope.runId, encodedByteLength: item.encodedByteLength, startedMonotonicMs: started.monotonicMs,
          completedMonotonicMs: clock.monotonicMs, inputId: item.inputId, inputSequence: item.inputSequence },
        processingStartedMs, marks: { ...marks, ingressJsonMs: null,
          workerTransferMs: processingStartedMs - (request.sharedMs - this.options.start.publisherTimeOriginMs) },
        decode: { startedMonotonicMs: decodeStarted, endedMonotonicMs: decodeEnded, xmlParseStartedMonotonicMs: this.threadToMeasured(parseTimes?.startedMs),
          xmlParseEndedMonotonicMs: this.threadToMeasured(parseTimes?.endedMs) },
        heap: this.options.start.measured && this.options.start.inputHeap ? threadHeap() : null,
        inputGenerations: this.options.start.measured ? this.inputGenerations(step, item.inputId) : null, generationRaisedMs,
        output: this.output([step]) });
        return;
      }
      case "deadline": {
        const step = this.apply(deadlineOwner(state, this.business(), this.options.units));
        this.options.reply({ kind: "deadlineDone", heap: this.options.start.measured ? threadHeap() : null, output: this.output([step]) });
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

  // P3-C4-AC13(3)②: この入力の採用で世代が上がった unit（generationInputIds にこの入力 ID を持つもの）の、返信の時点の世代。
  private inputGenerations(step: OwnerStep, inputId: string): Partial<Record<RuntimeUnitId, number>> {
    const raised: Partial<Record<RuntimeUnitId, number>> = {};
    for (const unit of this.own) if (step.generationInputIds[unit]?.includes(inputId)) raised[unit] = this.persistence(unit).currentGeneration;
    return raised;
  }

  // P3-C4-PARSE-MARK: この thread の performance.now() を publisher の測定時刻へ直す（timeOrigin の差を足す）。
  private threadToMeasured(ms: number | null | undefined): number | null {
    return ms == null ? null : ms + performance.timeOrigin - this.options.start.publisherTimeOriginMs;
  }

  private restore(runId: string): void {
    if (this.state != null) throw new Error("owner already restored");
    const clock = this.business();
    const { codecs, start } = this.options;
    // As validateAppConfig did for the single-thread root: slots live under the absolute state directory.
    this.coordinator = new CheckpointCoordinator(resolve(start.stateDirectory),
      Object.fromEntries(this.own.flatMap((unit) => codecs[unit] == null ? [] : [[unit, codecs[unit]]])), this.fileSystem,
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
      this.record(unit, base + 1, current, Object.hasOwn(ids, unit) ? ids[unit]! : null);
    }
    const views = new Map(ownerViews(this.state, this.options.units).map((view) => [view.unit, view]));
    const output = this.output([first, deadline]);
    this.options.reply({ kind: "restored", output, units: this.own.map((unit) => ({ ...this.delta(unit, views.get(unit)!),
      view: views.get(unit)!, pendingIntents: this.pending(unit),
      restoration: first.restoration[unit]! })) });
  }

  private grant(request: Extract<OwnerRequest, { kind: "checkpointGrant" }>): void {
    const grantStartedMs = this.options.start.measured ? this.measured() : null;
    const state = this.state!;
    const { unit, grantId } = request;
    // writeCounts は返信の時点の累積の写し（owner の write は権の処理の中だけで起きる、P3-C4-WRITE-COUNT）。
    const done = (result: CheckpointResult | null, measurements: readonly CheckpointMeasurement[], steps: readonly OwnerStep[]) =>
      this.options.reply({ kind: "checkpointDone", grantId, unit, result, measurements, grantStartedMs,
        writeCounts: this.writeCounts == null ? null : structuredClone(this.writeCounts), output: this.output(steps) });
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
    // The publisher holds one write right per unit (P3-UWR-AC01): a second save of a unit whose attempt is still open is a broken invariant.
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
        this.record(unit, previous.currentGeneration + 1, next.currentGeneration,
          Object.hasOwn(step.generationInputIds, unit) ? step.generationInputIds[unit]! : null);
        // 世代は昇順にだけ足されるので、保存確認済みの世代以下は Map の先頭から消せる（P3-OLB-AC03。番号の区間では回らない）。
        const ledger = this.ledger[unit];
        const saved = next.savedGeneration ?? 0;
        if (ledger != null) for (const generation of ledger.keys()) { if (generation > saved) break; ledger.delete(generation); }
      }
    }
    this.state = step.state;
    return step;
  }

  // 世代 from..to の入力 ID を足す。null は帰属不明で、unit をそのrunでは保存しない集合へ入れる。
  private record(unit: RuntimeUnitId, from: number, to: number, ids: readonly string[] | null): void {
    if (ids == null) { if (to >= from) this.unavailable.add(unit); return; }
    const ledger = this.ledger[unit] ??= new Map();
    for (let generation = from; generation <= to; generation++) {
      ledger.set(generation, ids);
      if (ledger.size > ledgerLimit) ledger.delete(ledger.keys().next().value!);
    }
  }

  // 残った項目の数だけ読む（P3-OLB-AC01 の検収用。状態は変えない）。
  ledgerSize(unit: RuntimeUnitId): number {
    return this.ledger[unit]?.size ?? 0;
  }

  private inputIds(unit: RuntimeUnitId): readonly string[] | null {
    if (this.unavailable.has(unit)) return null;
    const ids = new Set<string>();
    for (const value of this.ledger[unit]?.values() ?? []) for (const id of value) ids.add(id);
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
