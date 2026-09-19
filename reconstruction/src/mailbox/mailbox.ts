import type {
  MailboxCompletion,
  MailboxEnqueueResult,
  MailboxEnvelope,
  MailboxStats,
} from "../../contracts/p2-shared-runtime.types";

const ITEM_LIMIT = 128;
const BYTE_LIMIT = 16 * 1024 * 1024;
const NORMAL_ITEM_LIMIT = 120;
const NORMAL_BYTE_LIMIT = 14 * 1024 * 1024;
const RESERVED_ITEM_LIMIT = 8;
const RESERVED_BYTE_LIMIT = 2 * 1024 * 1024;

type Entry = {
  readonly envelope: MailboxEnvelope;
  readonly bytes: number;
  readonly allocation: "normal" | "reserved";
  dispatchedAt: number | null;
  completedStartFloor: number;
};

const encoder = new TextEncoder();

function confirmedNonNormal(envelope: MailboxEnvelope): boolean {
  if (envelope.payload.kind !== "parser") return false;
  const { headTest, envelopeStatus } = envelope.payload.item;
  return headTest.kind === "provided" && headTest.value
    || envelopeStatus.kind === "provided" && envelopeStatus.value !== "normal";
}

function allocation(envelope: MailboxEnvelope): Entry["allocation"] {
  return envelope.priorityReason !== "normal" && !confirmedNonNormal(envelope) ? "reserved" : "normal";
}

function encodedBytes(envelope: MailboxEnvelope): number {
  return envelope.payload.kind === "parser"
    ? envelope.payload.item.encodedByteLength
    : encoder.encode(JSON.stringify(envelope.payload)).byteLength;
}

function priority(entry: Entry): number {
  if (entry.envelope.payload.kind === "control") return 0;
  if (confirmedNonNormal(entry.envelope)) return 3;
  if (entry.envelope.priorityReason === "eewCandidate") return 1;
  if (entry.envelope.priorityReason === "tsunamiCandidate") return 2;
  return 3;
}

function operation(envelope: MailboxEnvelope): "normal" | "training" | "test" | "nonNormal" | "unknown" {
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

function sameOrderingDomain(left: MailboxEnvelope, right: MailboxEnvelope): boolean {
  if (left.payload.kind !== "parser" || right.payload.kind !== "parser") return false;
  if (left.payload.item.headType !== right.payload.item.headType) return false;
  const leftOperation = operation(left);
  const rightOperation = operation(right);
  return leftOperation === "unknown" || rightOperation === "unknown" || leftOperation === rightOperation;
}

class Mailbox {
  private accepting = true;
  private readonly pending: Entry[] = [];
  private parserInFlight: Entry | null = null;
  private readonly controlsInFlight: Entry[] = [];
  private lastProgress: number | null = null;
  private initialProgress: number | null = null;
  private lastArrival: number | null = null;
  private lastWorkerResponse: number | null = null;
  private highWaterItems = 0;
  private highWaterBytes = 0;
  private accepted = 0;
  private completed = 0;
  private rejected = 0;
  private limitViolations = 0;

  enqueue(envelope: MailboxEnvelope): MailboxEnqueueResult {
    this.lastArrival = envelope.enqueuedMonotonicMs;
    if (!this.accepting && envelope.payload.kind === "parser") return this.reject("draining", envelope.enqueuedMonotonicMs);

    const bytes = encodedBytes(envelope);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return this.reject("byteLimit", envelope.enqueuedMonotonicMs);
    const all = this.entries();
    const entry: Entry = { envelope, bytes, allocation: allocation(envelope), dispatchedAt: null,
      completedStartFloor: Math.max(Number.NEGATIVE_INFINITY, ...all
        .filter((candidate) => candidate.envelope.runId === envelope.runId && candidate.envelope.messageId === envelope.messageId)
        .map((candidate) => candidate.completedStartFloor)) };
    const lane = all.filter((candidate) => candidate.allocation === entry.allocation);
    const laneItemLimit = entry.allocation === "normal" ? NORMAL_ITEM_LIMIT : RESERVED_ITEM_LIMIT;
    const laneByteLimit = entry.allocation === "normal" ? NORMAL_BYTE_LIMIT : RESERVED_BYTE_LIMIT;
    if (all.length + 1 > ITEM_LIMIT || lane.length + 1 > laneItemLimit) return this.reject("itemLimit", envelope.enqueuedMonotonicMs);
    if (this.bytes(all) + bytes > BYTE_LIMIT || this.bytes(lane) + bytes > laneByteLimit) return this.reject("byteLimit", envelope.enqueuedMonotonicMs);

    this.pending.push(entry);
    const initial = envelope.payload.kind === "control" && envelope.payload.control.kind === "deadline"
      ? envelope.payload.control.clock.monotonicMs : envelope.enqueuedMonotonicMs;
    this.initialProgress = Math.min(this.initialProgress ?? initial, initial);
    this.accepted += 1;
    const current = this.entries();
    this.highWaterItems = Math.max(this.highWaterItems, current.length);
    this.highWaterBytes = Math.max(this.highWaterBytes, this.bytes(current));
    this.checkLimits();
    return { kind: "accepted", stats: this.stats(envelope.enqueuedMonotonicMs) };
  }

  takeNext(nowMonotonicMs: number): MailboxEnvelope | null {
    let selected = -1;
    let selectedPriority = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.pending.length; index += 1) {
      const entry = this.pending[index];
      if (entry.envelope.payload.kind === "parser") {
        if (this.parserInFlight != null) continue;
        if (this.pending.slice(0, index).some((earlier) => sameOrderingDomain(earlier.envelope, entry.envelope))) continue;
      }
      const candidatePriority = priority(entry);
      if (candidatePriority < selectedPriority) {
        selected = index;
        selectedPriority = candidatePriority;
      }
    }
    if (selected < 0) return null;

    const [entry] = this.pending.splice(selected, 1);
    entry.dispatchedAt = nowMonotonicMs;
    if (entry.envelope.payload.kind === "parser") this.parserInFlight = entry;
    else this.controlsInFlight.push(entry);
    this.lastProgress = Math.max(this.lastProgress ?? nowMonotonicMs, nowMonotonicMs);
    this.checkLimits();
    return entry.envelope;
  }

  complete(completion: MailboxCompletion): MailboxStats {
    const now = Number.isFinite(completion.completedMonotonicMs)
      ? completion.completedMonotonicMs
      : this.lastProgress ?? this.lastArrival ?? 0;
    if (!Number.isFinite(completion.startedMonotonicMs)
      || !Number.isFinite(completion.completedMonotonicMs)
      || completion.completedMonotonicMs < completion.startedMonotonicMs) return this.stats(now);

    if (completion.kind === "parser") {
      const entry = this.parserInFlight;
      if (entry == null || entry.envelope.payload.kind !== "parser"
        || entry.envelope.messageId !== completion.messageId
        || entry.envelope.runId !== completion.runId
        || entry.envelope.payload.item.inputId !== completion.inputId
        || entry.envelope.payload.item.inputSequence !== completion.inputSequence
        || entry.bytes !== completion.encodedByteLength
        || entry.dispatchedAt == null || completion.startedMonotonicMs < entry.dispatchedAt
        || completion.startedMonotonicMs <= entry.completedStartFloor) return this.stats(now);
      this.parserInFlight = null;
    } else {
      const index = this.controlsInFlight.findIndex((entry) => entry.envelope.messageId === completion.messageId
        && entry.envelope.runId === completion.runId
        && entry.bytes === completion.encodedByteLength
        && entry.dispatchedAt != null && completion.startedMonotonicMs >= entry.dispatchedAt
        && completion.startedMonotonicMs > entry.completedStartFloor);
      if (index < 0) return this.stats(now);
      this.controlsInFlight.splice(index, 1);
    }
    // Keep only a scalar on live colliding entries: even a cloned completion cannot
    // release a second job. Equal/older starts are ambiguous when callers reuse IDs.
    for (const entry of this.entries()) {
      if (entry.envelope.runId === completion.runId && entry.envelope.messageId === completion.messageId)
        entry.completedStartFloor = Math.max(entry.completedStartFloor, completion.startedMonotonicMs);
    }
    this.completed += 1;
    this.lastProgress = Math.max(this.lastProgress ?? completion.completedMonotonicMs, completion.completedMonotonicMs);
    this.checkLimits();
    return this.stats(now);
  }

  beginDrain(nowMonotonicMs: number): MailboxStats {
    this.accepting = false;
    this.checkLimits();
    return this.stats(nowMonotonicMs);
  }

  stats(nowMonotonicMs: number): MailboxStats {
    const pendingBytes = this.bytes(this.pending);
    const inFlight = [...(this.parserInFlight == null ? [] : [this.parserInFlight]), ...this.controlsInFlight];
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
      inFlightMessageId: this.parserInFlight?.envelope.messageId ?? null,
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
      rejected: this.rejected,
      limitViolations: this.limitViolations,
    };
  }

  recordWorkerResponse(nowMonotonicMs: number): MailboxStats {
    this.lastWorkerResponse = nowMonotonicMs;
    this.checkLimits();
    return this.stats(nowMonotonicMs);
  }

  private entries(): Entry[] {
    // ponytail: the declared 128-item ceiling makes a scan safer than mirrored counters.
    return [...this.pending, ...(this.parserInFlight == null ? [] : [this.parserInFlight]), ...this.controlsInFlight];
  }

  private bytes(entries: readonly Entry[]): number {
    return entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  private oldest(entries: readonly Entry[], nowMonotonicMs: number): number | null {
    return entries.length === 0 ? null : Math.max(0, nowMonotonicMs - Math.min(...entries.map((entry) => entry.envelope.enqueuedMonotonicMs)));
  }

  private reject(reason: "draining" | "itemLimit" | "byteLimit", nowMonotonicMs: number): MailboxEnqueueResult {
    this.rejected += 1;
    return { kind: "rejected", reason, stats: this.stats(nowMonotonicMs) };
  }

  private checkLimits(): void {
    const all = this.entries();
    const normal = all.filter((entry) => entry.allocation === "normal");
    const reserved = all.filter((entry) => entry.allocation === "reserved");
    if (all.length > ITEM_LIMIT || this.bytes(all) > BYTE_LIMIT
      || normal.length > NORMAL_ITEM_LIMIT || this.bytes(normal) > NORMAL_BYTE_LIMIT
      || reserved.length > RESERVED_ITEM_LIMIT || this.bytes(reserved) > RESERVED_BYTE_LIMIT) this.limitViolations += 1;
  }
}

export { Mailbox };
