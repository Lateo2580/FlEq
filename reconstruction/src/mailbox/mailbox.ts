import type {
  DiagnosticDetails,
  MailboxCompletion,
  MailboxEnqueueResult,
  MailboxEnvelope,
  MailboxStats,
} from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace, ParserSettlement } from "../../contracts/p3-execution-split.types";
import { placeOfHeadType } from "../runtime/unit-coverage";

const ITEM_LIMIT = 128;
const BYTE_LIMIT = 16 * 1024 * 1024;
const NORMAL_ITEM_LIMIT = 120;
const NORMAL_BYTE_LIMIT = 14 * 1024 * 1024;
const RESERVED_ITEM_LIMIT = 8;
const RESERVED_BYTE_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_ITEM_LIMIT = 64;

type Entry = {
  readonly envelope: MailboxEnvelope;
  readonly bytes: number;
  readonly allocation: "normal" | "reserved";
  // P3-C3A-AC03: decided at enqueue from headType (null for control items).
  readonly place: ExecutionPlace | null;
  dispatchedAt: number | null;
};

const encoder = new TextEncoder();

function allocation(envelope: MailboxEnvelope): Entry["allocation"] {
  if (envelope.payload.kind === "control") return "reserved";
  const classification = operation(envelope);
  return envelope.priorityReason !== "normal" && (classification === "normal" || classification === "unknown")
    ? "reserved" : "normal";
}

function encodedBytes(envelope: MailboxEnvelope): number {
  return envelope.payload.kind === "parser"
    ? envelope.payload.item.encodedByteLength
    : encoder.encode(JSON.stringify(envelope.payload)).byteLength;
}

function priority(entry: Entry): number {
  if (entry.envelope.payload.kind === "control") return 0;
  const classification = operation(entry.envelope);
  if (classification !== "normal" && classification !== "unknown") return 3;
  if (entry.envelope.priorityReason === "eewCandidate") return 1;
  if (entry.envelope.priorityReason === "tsunamiCandidate") return 2;
  return 3;
}

function operation(envelope: MailboxEnvelope): "normal" | "training" | "test" | "nonNormal" | "unknown" {
  // P2-A2-CLASSIFICATION table: scheduling only, not P1's final operation resolution.
  if (envelope.payload.kind !== "parser") return "unknown";
  const { headTest, envelopeStatus } = envelope.payload.item;
  if (headTest.kind === "missing" || headTest.kind === "invalid"
    || envelopeStatus.kind === "missing" || envelopeStatus.kind === "invalid") return "unknown";
  if (envelopeStatus.kind === "provided") {
    if (headTest.kind === "provided" && headTest.value !== (envelopeStatus.value !== "normal")) return "unknown";
    return envelopeStatus.value;
  }
  if (headTest.kind === "provided") return headTest.value ? "nonNormal" : "normal";
  return "unknown";
}

// P2-A2-CLASSIFICATION ordering domain: an earlier pending item of the same headType blocks a later one when the
// earlier is unknown and the later normal, or both share a known operation (not nonNormal). `seen` holds the
// operations met so far per headType, so one forward pass decides every entry (P3-C3A-RES-08).
function blockedByEarlier(seen: ReadonlyMap<string, ReadonlySet<string>>, envelope: MailboxEnvelope): boolean {
  if (envelope.payload.kind !== "parser") return false;
  const earlier = seen.get(envelope.payload.item.headType);
  if (earlier == null) return false;
  const current = operation(envelope);
  return current === "normal" && earlier.has("unknown")
    || current !== "unknown" && current !== "nonNormal" && earlier.has(current);
}

class Mailbox {
  private accepting = true;
  private readonly pending: Entry[] = [];
  // P3-C3A-RES-01: at most one normal data item in flight per execution place.
  private readonly parserInFlight = new Map<ExecutionPlace, Entry>();
  private readonly controlsInFlight: Entry[] = [];
  private lastProgress: number | null = null;
  private initialProgress: number | null = null;
  private lastArrival: number | null = null;
  private lastWorkerResponse: number | null = null;
  private highWaterItems = 0;
  private highWaterBytes = 0;
  private accepted = 0;
  private completed = 0;
  private cancelled = 0;
  private rejected = 0;
  private limitViolations = 0;
  private readonly diagnostics: DiagnosticDetails[] = [];
  private droppedDiagnostics = 0;
  private stalledReported = false;
  private unresponsiveReported = false;

  enqueue(envelope: MailboxEnvelope): MailboxEnqueueResult {
    this.lastArrival = envelope.enqueuedMonotonicMs;
    this.initialProgress ??= this.lastArrival;
    if (!this.accepting && envelope.payload.kind === "parser") return this.reject("draining", envelope.enqueuedMonotonicMs);

    const bytes = encodedBytes(envelope);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return this.reject("byteLimit", envelope.enqueuedMonotonicMs);
    const all = this.entries();
    const entry: Entry = { envelope, bytes, allocation: allocation(envelope), dispatchedAt: null,
      place: envelope.payload.kind === "parser" ? placeOfHeadType(envelope.payload.item.headType) : null };
    const lane = all.filter((candidate) => candidate.allocation === entry.allocation);
    const laneItemLimit = entry.allocation === "normal" ? NORMAL_ITEM_LIMIT : RESERVED_ITEM_LIMIT;
    const laneByteLimit = entry.allocation === "normal" ? NORMAL_BYTE_LIMIT : RESERVED_BYTE_LIMIT;
    if (all.length + 1 > ITEM_LIMIT || lane.length + 1 > laneItemLimit) return this.reject("itemLimit", envelope.enqueuedMonotonicMs);
    if (this.bytes(all) + bytes > BYTE_LIMIT || this.bytes(lane) + bytes > laneByteLimit) return this.reject("byteLimit", envelope.enqueuedMonotonicMs);

    this.pending.push(entry);
    this.accepted += 1;
    this.checkLimits();
    return { kind: "accepted", stats: this.stats(envelope.enqueuedMonotonicMs) };
  }

  takeNext(nowMonotonicMs: number): MailboxEnvelope | null {
    let selected = -1;
    let selectedPriority = Number.POSITIVE_INFINITY;
    const seen = new Map<string, Set<string>>();
    for (let index = 0; index < this.pending.length; index += 1) {
      const entry = this.pending[index];
      const { envelope } = entry;
      const eligible = entry.place == null || !this.parserInFlight.has(entry.place) && !blockedByEarlier(seen, envelope);
      if (envelope.payload.kind === "parser") {
        const { headType } = envelope.payload.item;
        const operations = seen.get(headType) ?? new Set<string>();
        operations.add(operation(envelope));
        seen.set(headType, operations);
      }
      if (!eligible) continue;
      const candidatePriority = priority(entry);
      if (candidatePriority < selectedPriority) {
        selected = index;
        selectedPriority = candidatePriority;
      }
    }
    if (selected < 0) return null;

    const [entry] = this.pending.splice(selected, 1);
    entry.dispatchedAt = nowMonotonicMs;
    if (entry.place != null) this.parserInFlight.set(entry.place, entry);
    else this.controlsInFlight.push(entry);
    this.lastProgress = Math.max(this.lastProgress ?? nowMonotonicMs, nowMonotonicMs);
    this.stalledReported = false;
    this.checkLimits();
    return entry.envelope;
  }

  // A parser input settles by identity only (P3-C3A-AC03); a whole MailboxCompletion is accepted as it is.
  complete(completion: ParserSettlement | Extract<MailboxCompletion, { kind: "control" }>): MailboxStats {
    const now = Number.isFinite(completion.completedMonotonicMs)
      ? completion.completedMonotonicMs
      : this.lastProgress ?? this.lastArrival ?? 0;
    if (!Number.isFinite(completion.startedMonotonicMs)
      || !Number.isFinite(completion.completedMonotonicMs)
      || completion.completedMonotonicMs < completion.startedMonotonicMs) return this.stats(now);

    if (completion.kind === "parser") {
      // A mismatched or repeated completion releases no place.
      const entry = [...this.parserInFlight.values()].find((candidate) => candidate.envelope.payload.kind === "parser"
        && candidate.envelope.messageId === completion.messageId
        && candidate.envelope.runId === completion.runId
        && candidate.envelope.payload.item.inputId === completion.inputId
        && candidate.envelope.payload.item.inputSequence === completion.inputSequence
        && candidate.bytes === completion.encodedByteLength
        && candidate.dispatchedAt != null && completion.startedMonotonicMs >= candidate.dispatchedAt);
      if (entry?.place == null) return this.stats(now);
      this.parserInFlight.delete(entry.place);
    } else {
      const index = this.controlsInFlight.findIndex((entry) => entry.envelope.messageId === completion.messageId
        && entry.envelope.runId === completion.runId
        && entry.bytes === completion.encodedByteLength
        && entry.dispatchedAt != null && completion.startedMonotonicMs >= entry.dispatchedAt);
      if (index < 0) return this.stats(now);
      this.controlsInFlight.splice(index, 1);
    }
    this.completed += 1;
    this.lastProgress = Math.max(this.lastProgress ?? completion.completedMonotonicMs, completion.completedMonotonicMs);
    this.stalledReported = false;
    this.checkLimits();
    return this.stats(now);
  }

  cancel(inputId: string, nowMonotonicMs: number): MailboxStats {
    const index = this.pending.findIndex(({ envelope }) => envelope.payload.kind === "parser"
      && envelope.payload.item.inputId === inputId);
    if (index < 0) return this.stats(nowMonotonicMs);
    this.pending.splice(index, 1);
    this.cancelled += 1;
    this.checkLimits();
    return this.stats(nowMonotonicMs);
  }

  beginDrain(nowMonotonicMs: number): MailboxStats {
    this.accepting = false;
    this.checkLimits();
    return this.stats(nowMonotonicMs);
  }

  stats(nowMonotonicMs: number): MailboxStats {
    const pendingBytes = this.bytes(this.pending);
    const inFlight = [...this.parserInFlight.values(), ...this.controlsInFlight];
    const all = [...this.pending, ...inFlight];
    const pendingOldest = this.oldest(this.pending, nowMonotonicMs);
    const incompleteOldest = this.oldest(all, nowMonotonicMs);
    const deadlines = all.flatMap((entry) => entry.envelope.payload.kind === "control"
      && entry.envelope.payload.control.kind === "deadline" ? [entry.envelope.payload.control.clock.monotonicMs] : []);
    return {
      accepting: this.accepting,
      pendingItems: this.pending.length,
      pendingBytes,
      inFlightItems: inFlight.length,
      inFlightBytes: this.bytes(inFlight),
      inFlightMessageIds: [...this.parserInFlight.values()].map((entry) => entry.envelope.messageId),
      inFlightControlMessageIds: this.controlsInFlight.map((entry) => entry.envelope.messageId),
      lastProgressMonotonicMs: this.lastProgress ?? this.initialProgress,
      lastArrivalMonotonicMs: this.lastArrival,
      lastWorkerResponseMonotonicMs: this.lastWorkerResponse,
      nextDeadlineMonotonicMs: deadlines.length === 0 ? null : Math.min(...deadlines),
      highWaterItems: this.highWaterItems,
      highWaterBytes: this.highWaterBytes,
      oldestPendingAgeMs: pendingOldest,
      oldestIncompleteAgeMs: incompleteOldest,
      accepted: this.accepted,
      completed: this.completed,
      cancelled: this.cancelled,
      rejected: this.rejected,
      limitViolations: this.limitViolations,
    };
  }

  recordWorkerResponse(nowMonotonicMs: number): MailboxStats {
    this.lastWorkerResponse = nowMonotonicMs;
    this.unresponsiveReported = false;
    return this.stats(nowMonotonicMs);
  }

  isStalled(nowMonotonicMs: number): boolean {
    return this.stalledDurationMs(nowMonotonicMs) != null;
  }

  drainDiagnostics(nowMonotonicMs: number): DiagnosticDetails[] {
    if (this.initialProgress != null) {
      const stalledMs = this.stalledDurationMs(nowMonotonicMs);
      if (!this.stalledReported && stalledMs != null) {
        this.diagnose("mailboxStalled", "mailbox", stalledMs);
        this.stalledReported = true;
      }
      const response = Math.max(this.initialProgress, this.lastWorkerResponse ?? this.initialProgress);
      if (!this.unresponsiveReported && nowMonotonicMs - response >= 5_000) {
        this.diagnose("mailboxStalled", "mailbox.worker", nowMonotonicMs - response);
        this.unresponsiveReported = true;
      }
    }
    if (this.droppedDiagnostics > 0) {
      if (this.diagnostics.length === DIAGNOSTIC_ITEM_LIMIT) {
        this.diagnostics.shift();
        this.droppedDiagnostics += 1;
      }
      this.diagnostics.push({ level: "WARN", component: "mailbox", reason: "diagnosticQueueOverflow",
        count: this.droppedDiagnostics });
      this.droppedDiagnostics = 0;
    }
    return this.diagnostics.splice(0);
  }

  // AC05 stalled predicate shared by drainDiagnostics (reports) and isStalled (read-only).
  private stalledDurationMs(nowMonotonicMs: number): number | null {
    if (this.initialProgress == null) return null;
    const all = this.entries();
    if (all.length === 0) return null;
    let progress = Math.max(this.initialProgress, this.lastProgress ?? this.initialProgress);
    if (all.every(({ envelope }) => envelope.payload.kind === "control"
      && envelope.payload.control.kind === "deadline")) {
      progress = Math.max(progress, this.stats(nowMonotonicMs).nextDeadlineMonotonicMs!);
    }
    return nowMonotonicMs - progress >= 5_000 ? nowMonotonicMs - progress : null;
  }

  private diagnose(reason: "mailboxRejectedDraining" | "mailboxRejectedItemLimit" | "mailboxRejectedByteLimit"
    | "mailboxStalled" | "mailboxLimitViolation", component: "mailbox" | "mailbox.worker" = "mailbox", durationMs?: number): void {
    if (this.diagnostics.length === DIAGNOSTIC_ITEM_LIMIT) {
      this.diagnostics.shift();
      this.droppedDiagnostics += 1;
    }
    this.diagnostics.push({ level: reason === "mailboxLimitViolation" ? "ERROR" : "WARN",
      component, reason, count: 1, ...(durationMs == null ? {} : { durationMs }) });
  }

  private entries(): Entry[] {
    // ponytail: the declared 128-item ceiling makes a scan safer than mirrored counters.
    return [...this.pending, ...this.parserInFlight.values(), ...this.controlsInFlight];
  }

  private bytes(entries: readonly Entry[]): number {
    return entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  private oldest(entries: readonly Entry[], nowMonotonicMs: number): number | null {
    return entries.length === 0 ? null : Math.max(0, nowMonotonicMs - Math.min(...entries.map((entry) => entry.envelope.enqueuedMonotonicMs)));
  }

  private reject(reason: "draining" | "itemLimit" | "byteLimit", nowMonotonicMs: number): MailboxEnqueueResult {
    this.rejected += 1;
    this.diagnose(reason === "draining" ? "mailboxRejectedDraining"
      : reason === "itemLimit" ? "mailboxRejectedItemLimit" : "mailboxRejectedByteLimit");
    return { kind: "rejected", reason, stats: this.stats(nowMonotonicMs) };
  }

  private checkLimits(): void {
    const all = this.entries();
    this.highWaterItems = Math.max(this.highWaterItems, all.length);
    this.highWaterBytes = Math.max(this.highWaterBytes, this.bytes(all));
    const normal = all.filter((entry) => entry.allocation === "normal");
    const reserved = all.filter((entry) => entry.allocation === "reserved");
    if (all.length > ITEM_LIMIT || this.bytes(all) > BYTE_LIMIT
      || normal.length > NORMAL_ITEM_LIMIT || this.bytes(normal) > NORMAL_BYTE_LIMIT
      || reserved.length > RESERVED_ITEM_LIMIT || this.bytes(reserved) > RESERVED_BYTE_LIMIT) {
      this.limitViolations += 1;
      this.diagnose("mailboxLimitViolation");
    }
  }
}

export { Mailbox };
