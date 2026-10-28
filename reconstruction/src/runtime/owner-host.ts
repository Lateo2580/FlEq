import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { ParserMailboxItem, ParserMailboxResult, ProcessingMarks } from "../../contracts/p1-parser-boundary.types";
import type { UnitTable } from "../../contracts/p3-unit-table.types";
import type { CheckpointMeasurement } from "../../contracts/p2-eew-e01.types";
import type {
  OwnerHeap, OwnerOutput, OwnerReply, OwnerRequest, OwnerStartData, OwnerUnitDelta, RecoveryInputResult, SentClock,
} from "../../contracts/p3-execution-split.types";
import type {
  CheckpointResult, ClockReading, CurrentConfirmationEvidence, DiagnosticEvent, NotificationIntent, RestoreUnitResult, RuntimeUnitId,
  RuntimeUnitStates, RuntimeUnitView, WallBasis,
} from "../../contracts/p2-shared-runtime.types";
import { CheckpointCoordinator } from "../checkpoint/checkpoint";
import type { CheckpointFileSystem, CodecMap } from "../checkpoint/checkpoint";
import { decodeMaterial } from "../decode-material/decode-material";
import { countedCheckpointFileSystem, writeCounters } from "./composition-root";
import type { WriteCounters } from "./composition-root";
import {
  adoptRecoveryOwner, capturedOwner, checkpointResultOwner, deadlineOwner, detailOwner, finalizeOwner, intentUpdateOwner, ownerViews, placeUnits,
  receiveOwner, recoveryResult, refreshedViews, restoreOwner, sameBase, shutdownInputOwner,
} from "./owner-runtime";
import type { OwnerState, OwnerStep } from "./owner-runtime";
import { completeDiagnostic } from "./runtime-diagnostic";
import { classifyHeadType } from "./unit-coverage";

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
// P3-REC-RES-08: owner が持つ候補 1 つの本文（受けた bytes）。越えた候補は基点が変わったら作り直さずに generationConflict（置き値）。urgent の候補は本文 28 件まで（当て直しの間 EEW が待つので 50 ms の内に収める置き値、P3-REC-D-REAPPLY-SHAPE=A）。
const CANDIDATE_BYTES = 16 * 1024 * 1024, URGENT_REAPPLY_ITEMS = 28;

// P3-REC-AC05・AC07: 開いている取り直しの候補。shadow は base（開いた時の live）から本文を当てた owner の state で、live には触れない。
// items は基点が変わったときに当て直すために持つ本文（RES-08 の内だけ）。diagnostics と負の証拠は採否が決まるまで出さない（P3-REC-AC06）。
type Candidate = {
  readonly recoveryId: string; readonly unit: RuntimeUnitId; readonly base: OwnerState; readonly open: OwnerState;
  shadow: OwnerState; readonly items: ParserMailboxItem[]; bytes: number; overflow: boolean;
  results: Map<number, RecoveryInputResult["result"]>; diagnostics: DiagnosticEvent[]; evidence: CurrentConfirmationEvidence[];
  readonly inputIds: string[];
};

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
  // P3-EF-AC02 (7): restore・input・deadline の直前の要求の根拠（保存しない。起動後の最初の restore は直前が verified でないと数える）。
  private lastBasis: WallBasis | null = null;
  // P3-C4-WRITE-COUNT: 測定の印があるときだけ、注入された filesystem を数える包みで使う（印が無ければ包みも counter も作らない）。
  private readonly writeCounts: WriteCounters | null;
  private readonly fileSystem: CheckpointFileSystem;
  // P3-REC-AC05: 1 回に候補は 1 つ（spec:2211）。採否が決まる・捨てる・shutdownInput で外す。
  private candidate: Candidate | null = null;

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
    this.base = { clock: request.clock, sharedMs: request.sharedMs, basis: request.basis };
    // 根拠の切替えは結果を返して期限を当てる restore・input・deadline の要求だけで数える（detail などは直前の根拠を書き換えない）。
    const switched = (request.kind === "restore" || request.kind === "input" || request.kind === "deadline")
      && this.switchedToVerified(request.basis);
    if (request.kind === "restore") { this.restore(request.runId, switched); return; }
    const state = this.state;
    if (state == null) throw new Error("owner has not restored");
    if (state.finalized && request.kind !== "checkpointGrant") throw new Error("owner is finalized");
    switch (request.kind) {
      case "input": {
        const started = this.business();
        const processingStartedMs = this.measured();
        const { envelope } = request;
        const { item } = envelope.payload;
        if (item.origin === "recovery") { this.recoveryInput(request, switched); return; }
        const parseTimes: { startedMs: number | null; endedMs: number | null } | undefined =
          this.options.start.measured ? { startedMs: null, endedMs: null } : undefined;
        const decodeStarted = this.measured();
        const result: ParserMailboxResult = decodeMaterial(item, parseTimes);
        const decodeEnded = this.measured();
        const clock = this.business();
        let generationRaisedMs: number | null = null;
        const forced = switched ? this.apply(deadlineOwner(state, clock, this.options.units, request.basis, true)) : null;
        const step = this.apply(receiveOwner(this.state!, { runId: envelope.runId, inputId: item.inputId, result, headType: item.headType,
          receivedAt: item.receivedAt, origin: item.origin }, clock, this.options.units,
          this.options.start.measured ? () => { generationRaisedMs = this.measured(); } : undefined, request.basis));
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
        output: this.output(forced == null ? [step] : [forced, step]) });
        return;
      }
      case "deadline": {
        const step = this.apply(deadlineOwner(state, this.business(), this.options.units, request.basis, switched));
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
        // P3-REC-AC05: 停止では開いている候補を採用せずに捨てる。
        this.candidate = null;
        const step = this.apply(shutdownInputOwner(state, this.business(), this.options.units, request.basis));
        this.options.reply({ kind: "shutdownInputDone", output: this.output([step]) });
        return;
      }
      case "finalize": {
        const step = this.apply(finalizeOwner(state, request.cutoff, this.options.units, request.basis));
        this.options.reply({ kind: "finalizeDone", appliedThrough: request.cutoff, output: this.output([step]) });
        return;
      }
      case "recovery": this.recovery(request); return;
      case "detail": this.options.reply({ kind: "detailDone", response: detailOwner(state, request.detail) }); return; default: { const unknown: never = request; throw new Error(`unknown owner request ${String(unknown)}`); }
    }
  }

  // P3-REC-AC05: origin=recovery の本文。候補が開いていれば shadow に当て（live・publisher には何も出さない、P3-REC-AC06）、開いていなければ
  // 適用せずに WARN だけで捨てる（discard や owner の再起動の後に mailbox に残った本文）。どちらも inputDone で mailbox の枠を外す。
  private recoveryInput(request: Extract<OwnerRequest, { kind: "input" }>, switched: boolean): void {
    const started = this.business();
    const processingStartedMs = this.measured();
    const { envelope } = request;
    const { item } = envelope.payload;
    const forced = switched ? this.apply(deadlineOwner(this.state!, started, this.options.units, request.basis, true)) : null;
    const result = decodeMaterial(item);
    const clock = this.business();
    const candidate = this.candidate;
    const route = classifyHeadType(result.kind === "decoded" ? result.material.headType : item.headType);
    if (candidate == null || route.status !== "ready" || route.unit !== candidate.unit) {
      this.diagnostics.push(completeDiagnostic({ level: "WARN", component: "recovery", reason: "recoveryBaseMissing", inputId: item.inputId },
        clock, this.state!.runId));
    } else {
      this.applyCandidate(candidate, item, result, clock, request.basis, candidate.base);
      // RES-08 の内だけ当て直し用に持つ。越えたら基点が変わったときに作り直さない。
      if (!candidate.overflow && candidate.bytes + item.encodedByteLength <= CANDIDATE_BYTES && (this.options.start.place !== "urgent" || candidate.items.length < URGENT_REAPPLY_ITEMS)) {
        candidate.items.push(item);
        candidate.bytes += item.encodedByteLength;
      } else { candidate.overflow = true; candidate.items.length = 0; }
    }
    this.options.reply({ kind: "inputDone", settlement: { kind: "parser", messageId: envelope.messageId, runId: envelope.runId,
      encodedByteLength: item.encodedByteLength, startedMonotonicMs: started.monotonicMs, completedMonotonicMs: clock.monotonicMs,
      inputId: item.inputId, inputSequence: item.inputSequence }, processingStartedMs, marks: noMarks, decode: null, heap: null,
    inputGenerations: null, generationRaisedMs: null, output: this.output(forced == null ? [] : [forced]) });
  }

  private applyCandidate(candidate: Candidate, item: ParserMailboxItem, result: ParserMailboxResult, clock: ClockReading, basis: WallBasis, start: OwnerState): void { // start は shadow の基点（開いた時の live、当て直しでは今の live。U-R の期限の intent の判定、P3-REC-AC12）
    const completion = { runId: candidate.shadow.runId, inputId: item.inputId, result, headType: item.headType, receivedAt: item.receivedAt, origin: item.origin };
    const seen = { held: false, base: start };
    const step = receiveOwner(candidate.shadow, completion, clock, this.options.units, undefined, basis, seen);
    candidate.shadow = step.state;
    candidate.results.set(item.inputSequence, recoveryResult(completion, step, seen.held));
    candidate.diagnostics.push(...step.diagnostics);
    candidate.evidence.push(...step.confirmationEvidence.filter((evidence) => evidence.source !== "acceptedReport"));
    candidate.inputIds.push(item.inputId);
  }

  // P3-REC-AC05・AC07: 候補の要求（open・adopt・discard）。返信は 1 要求に 1 つ（recovery の未回答 1 件）。
  private recovery(request: Extract<OwnerRequest, { kind: "recovery" }>): void {
    const state = this.state!;
    const { recoveryId, unit } = request;
    const done = (result: Extract<OwnerReply, { kind: "recoveryDone" }>["result"], output: OwnerOutput = this.output([])) =>
      this.options.reply({ kind: "recoveryDone", recoveryId, unit, result, output });
    if (request.phase === "open") {
      if (state.units[unit] == null) throw new Error(`unit ${unit} is not owned here`);
      this.candidate = { recoveryId, unit, base: state, open: state, shadow: state, items: [], bytes: 0, overflow: false, results: new Map(),
        diagnostics: [], evidence: [], inputIds: [] };
      done({ kind: "opened" });
      return;
    }
    const candidate = this.candidate;
    this.candidate = null;
    if (request.phase === "discard") { done({ kind: "discarded" }); return; }
    if (candidate == null || candidate.recoveryId !== recoveryId || candidate.unit !== unit) { done({ kind: "unsatisfied", reason: "baseMissing" }); return; }
    const clock = this.business();
    if (!sameBase(state, candidate.base, unit)) {
      // P3-REC-AC07: 基点が変わった（live の入力・期限・保存）。持っている本文を今の live に当て直す。live の入力は当て直さない。
      if (candidate.overflow) { done({ kind: "generationConflict" }); return; }
      const items = [...candidate.items];
      Object.assign(candidate, { shadow: state, results: new Map(), diagnostics: [], evidence: [] });
      candidate.inputIds.length = 0;
      for (const item of items) this.applyCandidate(candidate, item, decodeMaterial(item), clock, request.basis, state);
    }
    const step = adoptRecoveryOwner(state, candidate.shadow, unit, recoveryId, candidate.open, candidate.inputIds, clock, this.options.units, request.basis);
    // 部分集合の検査に外れた候補は捨てる（P3-REC-D-UNIT-ENTRANCE の共有の検査）。
    if (step == null) { done({ kind: "generationConflict" }); return; }
    this.apply(step);
    const output = this.output([step]);
    done({ kind: "adopted", generation: this.persistence(unit).currentGeneration,
      inputs: [...candidate.results].map(([inputSequence, result]) => ({ inputSequence, result })) },
    { ...output, confirmationEvidence: candidate.evidence, diagnostics: [...candidate.diagnostics, ...output.diagnostics] });
  }

  private switchedToVerified(basis: WallBasis): boolean {
    const switched = basis === "verified" && this.lastBasis !== "verified";
    this.lastBasis = basis;
    return switched;
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

  private restore(runId: string, switched: boolean): void {
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
    const basis = this.base!.basis;
    const first = restoreOwner({ runId, place: this.options.start.place, clock, basis, restored }, this.options.units, this.options.codecs);
    const deadline = deadlineOwner(first.state, clock, this.options.units, basis, switched);
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
      restoration: first.restoration[unit]!, inputBoundary: first.restoration[unit]?.kind === "restored" && restored[unit]?.kind === "restored" ? restored[unit].envelope.inputBoundary ?? null : null, saves: this.checkpoint.saves(unit) })) }); // P3-VM-AC05・AC06: 復元した世代の境界と保存の可否
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
    const scheduled = this.checkpoint.capture(unit, state.units[unit], persistence.currentGeneration, state.runId, correlation, request.inputBoundary,
      state.losses[unit], state.unreadable[unit]);
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
      done(executed.result, [...scheduled.measurements, ...executed.measurements], [refreshedViews(captured, this.state!, this.options.units), step]);
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
    return { unit, persistence: this.persistence(unit), view,
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
