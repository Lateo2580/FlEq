import { join } from "node:path";

import type { ParserDiagnostic } from "../../contracts/p1-parser-boundary.types";
import type {
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticReason,
  DiagnosticReadQuery,
  DiagnosticReadResult,
  DiagnosticSinkResult,
  ParserDiagnosticProjection,
  ParserDiagnosticReason,
  ShutdownSummary,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { completeDiagnostic } from "../runtime/runtime-diagnostic";

type DiagnosticFile = Readonly<{ name: string; size: number; mtimeMs: number }>;

type DiagnosticFileSystem = Readonly<{
  mkdir(path: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string>;
  files(path: string): Promise<readonly DiagnosticFile[]>;
  unlink(path: string): Promise<void>;
}>;

type QueueEntry = Readonly<{ event: DiagnosticEvent; line: string; bytes: number; occurrences: number }>;

const ITEM_LIMIT = 256;
const BYTE_LIMIT = 1024 * 1024;
const LINE_LIMIT = 8192;
const RETENTION_BYTES = 100 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const utf8 = new TextEncoder();
const levels = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
const units = ["U-E", "U-Q", "U-T", "U-N", "U-W", "U-L", "U-F", "U-B", "U-M", "U-Y", "U-V", "U-R"] as const;
const parserReasons = [
  "operationMissing", "operationInvalid", "operationMismatch", "operationAmbiguous",
  "formatUnsupported", "inputTooLarge", "envelopeInvalid", "encodingUnsupported",
  "compressionUnsupported", "bodyDecodeFailed", "expandedBodyInvalid",
  "expandedBodyTooLarge", "xmlLimitExceeded", "xmlInvalid",
] satisfies readonly ParserDiagnosticReason[];
const diagnosticReasons = [
  ...parserReasons,
  "headMissing", "reportDateTimeMissing", "reportDateTimeInvalid", "identityMissing", "identityInvalid",
  "requiredStructureMissing", "requiredStructureInvalid",
  "checkpointEncodeFailed", "checkpointWriteFailed", "checkpointFileSyncFailed", "checkpointCloseFailed",
  "checkpointRenameFailed", "checkpointDirectorySyncFailed", "checkpointVerifyFailed",
  "checkpointRetryScheduled", "checkpointOverdue", "checkpointUncertain", "checkpointRestoreRejected",
  "mailboxRejectedDraining", "mailboxRejectedItemLimit", "mailboxRejectedByteLimit", "mailboxStalled",
  "mailboxLimitViolation", "shutdownStarted", "shutdownUnsavedUnits", "diagnosticSinkFailed",
  "diagnosticQueueOverflow", "snapshotNoticeCapacityExceeded", "snapshotCommonBudgetExceeded",
  "snapshotStringLimitExceeded", "weatherCurrentCapacityEvicted", "eewCapacityEvicted",
] satisfies readonly DiagnosticReason[];

function lineFor(source: DiagnosticEvent, occurrences = 1): QueueEntry {
  const event = completeDiagnostic(source, { wallTimeMs: source.timestamp, monotonicMs: 0 }, source.runId);
  const ordered: DiagnosticEvent = {
    timestamp: event.timestamp,
    level: event.level,
    component: event.component,
    reason: event.reason,
    runId: event.runId,
    ...(event.inputId == null ? {} : { inputId: event.inputId }),
    ...(event.unit == null ? {} : { unit: event.unit }),
    ...(event.generation == null ? {} : { generation: event.generation }),
    ...(event.attemptId == null ? {} : { attemptId: event.attemptId }),
    ...(event.durationMs == null ? {} : { durationMs: event.durationMs }),
    ...(event.count == null ? {} : { count: event.count }),
  };
  const line = `${JSON.stringify(ordered)}\n`;
  const bytes = utf8.encode(line).byteLength;
  if (bytes > LINE_LIMIT) throw new Error("bounded diagnostic exceeded line limit");
  return { event: Object.freeze({ ...ordered }), line, bytes, occurrences };
}

function validQuery(query: DiagnosticReadQuery): boolean {
  return Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= ITEM_LIMIT
    && (query.level == null || levels.includes(query.level))
    && (query.unit == null || units.includes(query.unit))
    && (query.fromTimestampMs == null || Number.isFinite(query.fromTimestampMs))
    && (query.throughTimestampMs == null || Number.isFinite(query.throughTimestampMs))
    && (query.fromTimestampMs == null || query.throughTimestampMs == null
      || query.fromTimestampMs <= query.throughTimestampMs);
}

function parsedEvent(value: unknown): DiagnosticEvent | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const allowed = new Set(["timestamp", "level", "component", "reason", "runId", "inputId", "unit",
    "generation", "attemptId", "durationMs", "count"]);
  if (Object.keys(event).some((key) => !allowed.has(key))
    || typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)
    || typeof event.component !== "string" || typeof event.reason !== "string"
    || !diagnosticReasons.includes(event.reason as DiagnosticReason) || typeof event.runId !== "string"
    || typeof event.level !== "string" || !levels.includes(event.level as DiagnosticLevel)) return null;
  if (event.unit != null && (typeof event.unit !== "string" || !units.includes(event.unit as UnitId))) return null;
  if (event.inputId != null && typeof event.inputId !== "string"
    || event.attemptId != null && typeof event.attemptId !== "string") return null;
  for (const key of ["generation", "durationMs", "count"] as const)
    if (event[key] != null && (typeof event[key] !== "number" || !Number.isFinite(event[key]))) return null;
  return Object.freeze({ ...event }) as unknown as DiagnosticEvent;
}

function failureKey(event: DiagnosticEvent): string | null {
  if (event.level !== "WARN" && event.level !== "ERROR") return null;
  const { timestamp: _timestamp, count: _count, ...identity } = event;
  return JSON.stringify([new Date(event.timestamp).toISOString().slice(0, 10), identity]);
}

// One first record plus one cumulative repeat record, bounded by the retained file.
function compactRecords(records: readonly DiagnosticEvent[]): DiagnosticEvent[] {
  const result: DiagnosticEvent[] = [];
  const groups = new Map<string, { repeated: number | null }>();
  for (const event of records) {
    const key = failureKey(event);
    const group = key == null ? undefined : groups.get(key);
    if (group == null) {
      if (key != null && event.count == null && groups.size < ITEM_LIMIT)
        groups.set(key, { repeated: null });
      result.push(event);
    } else if (group.repeated == null) {
      group.repeated = result.length;
      result.push({ ...event, count: event.count ?? 1 });
    } else {
      const previous = result[group.repeated];
      result[group.repeated] = { ...event, timestamp: Math.min(previous.timestamp, event.timestamp), count: Math.min(Number.MAX_SAFE_INTEGER,
        (previous.count ?? 0) + (event.count ?? 1)) };
    }
  }
  return result;
}

class PersistentDiagnosticSink {
  private readonly queue: QueueEntry[] = [];
  private inFlight: readonly QueueEntry[] = [];
  private queuedBytes = 0;
  private inFlightBytes = 0;
  private flushing: Promise<void> | null = null;
  private available = true;
  private reporting = false;
  private overflowPending = false;
  private readonly startup: Promise<void>;
  private fileOperation: Promise<void> = Promise.resolve();
  private readonly dropped: Record<DiagnosticLevel, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };

  constructor(
    private readonly directory: string,
    private readonly fileSystem: DiagnosticFileSystem,
    private readonly readWallTime: () => number,
    private readonly reportFailure: (event: DiagnosticEvent) => void,
  ) {
    this.startup = this.serial(() => this.prune(this.readWallTime())).catch(() => { this.fail(); });
  }

  enqueueDiagnostic(event: DiagnosticEvent): DiagnosticSinkResult {
    // A failure callback may feed the event back: never enqueue or recursively report it.
    if (this.reporting) return { kind: "dropped", reason: "sinkUnavailable", level: event.level, count: this.dropped[event.level] };
    if (!this.available) return this.drop(event.level, "sinkUnavailable");
    let entry = lineFor(event);
    const key = failureKey(entry.event);
    if (key != null && entry.event.count == null) {
      const first = this.queue.find((candidate) => failureKey(candidate.event) === key && candidate.event.count == null);
      if (first != null) {
        const repeated = this.queue.findIndex((candidate) => failureKey(candidate.event) === key && candidate.event.count != null);
        entry = lineFor({ ...entry.event,
          timestamp: repeated < 0 ? entry.event.timestamp : Math.min(entry.event.timestamp, this.queue[repeated].event.timestamp),
          count: repeated < 0 ? 1
          : Math.min(Number.MAX_SAFE_INTEGER, this.queue[repeated].event.count! + 1) },
        repeated < 0 ? 1 : Math.min(Number.MAX_SAFE_INTEGER, this.queue[repeated].occurrences + 1));
        if (repeated >= 0) {
          const bytes = this.queuedBytes - this.queue[repeated].bytes + entry.bytes;
          if (bytes + this.inFlightBytes > BYTE_LIMIT) return this.drop(event.level, "byteLimit");
          this.queue[repeated] = entry;
          this.queuedBytes = bytes;
          return { kind: "accepted", queuedItems: this.queue.length + this.inFlight.length,
            queuedBytes: this.queuedBytes + this.inFlightBytes };
        }
      }
    }
    while (this.queue.length + this.inFlight.length + 1 > ITEM_LIMIT
      || this.queuedBytes + this.inFlightBytes + entry.bytes > BYTE_LIMIT) {
      const index = this.queue.findIndex((candidate) => candidate.event.level === "DEBUG") >= 0
        ? this.queue.findIndex((candidate) => candidate.event.level === "DEBUG")
        : this.queue.findIndex((candidate) => candidate.event.level === "INFO");
      if (index < 0 || levels.indexOf(this.queue[index].event.level) >= levels.indexOf(entry.event.level))
        return this.drop(event.level, this.queue.length + this.inFlight.length + 1 > ITEM_LIMIT ? "itemLimit" : "byteLimit");
      const [removed] = this.queue.splice(index, 1);
      this.queuedBytes -= removed.bytes;
      this.dropped[removed.event.level] += 1;
      this.overflowPending = true;
    }
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    this.scheduleFlush();
    return { kind: "accepted", queuedItems: this.queue.length + this.inFlight.length,
      queuedBytes: this.queuedBytes + this.inFlightBytes };
  }

  async flush(): Promise<void> {
    await this.startup;
    if (this.flushing != null) { await this.flushing; return this.flush(); }
    this.reportOverflow();
    if (!this.available || this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    this.inFlight = batch;
    this.inFlightBytes = batch.reduce((sum, entry) => sum + entry.bytes, 0);
    this.queuedBytes = 0;
    this.flushing = this.serial(async () => {
      const appended = new Set<QueueEntry>();
      try {
        await this.fileSystem.mkdir(this.directory);
        const grouped = new Map<string, QueueEntry[]>();
        for (const entry of batch) {
          const date = new Date(entry.event.timestamp).toISOString().slice(0, 10);
          const entries = grouped.get(date) ?? [];
          entries.push(entry);
          grouped.set(date, entries);
        }
        for (const [date, entries] of grouped) {
          const content = compactRecords(entries.map((entry) => entry.event)).map((event) => lineFor(event).line).join("");
          await this.fileSystem.appendFile(join(this.directory, `diagnostics-${date}.jsonl`), content);
          entries.forEach((entry) => appended.add(entry));
        }
        await this.prune(this.readWallTime());
      } catch {
        // A failed maintenance replacement cannot erase successfully appended records.
        for (const entry of batch)
          if (!appended.has(entry))
            this.dropped[entry.event.level] += entry.occurrences;
        for (const entry of this.queue.splice(0)) this.dropped[entry.event.level] += entry.occurrences;
        this.queuedBytes = 0;
        this.fail();
      } finally {
        this.inFlight = [];
        this.inFlightBytes = 0;
        this.flushing = null;
        this.reportOverflow();
        if (this.queue.length !== 0 && this.available) this.scheduleFlush();
      }
    });
    await this.flushing;
    if (this.queue.length !== 0) await this.flush();
  }

  async readDiagnostics(query: DiagnosticReadQuery): Promise<DiagnosticReadResult> {
    if (!validQuery(query)) throw new RangeError("invalid diagnostic query");
    await this.flush();
    return this.serial(async () => {
      try {
        await this.prune(this.readWallTime());
        const files = (await this.fileSystem.files(this.directory))
          .filter((file) => /^diagnostics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.name))
          .sort((left, right) => left.name.localeCompare(right.name));
        const matches: { event: DiagnosticEvent; order: number }[] = [];
        let order = 0;
        for (const file of files) {
          const content = await this.fileSystem.readFile(join(this.directory, file.name));
          for (const line of content.split("\n")) {
            if (line === "" || utf8.encode(`${line}\n`).byteLength > LINE_LIMIT) continue;
            let value: unknown;
            try { value = JSON.parse(line); } catch { continue; }
            const event = parsedEvent(value);
            if (event == null || query.level != null && event.level !== query.level
              || query.unit != null && event.unit !== query.unit
              || query.fromTimestampMs != null && event.timestamp < query.fromTimestampMs
              || query.throughTimestampMs != null && event.timestamp > query.throughTimestampMs) continue;
            matches.push({ event, order: order++ });
          }
        }
        matches.sort((left, right) => left.event.timestamp - right.event.timestamp || left.order - right.order);
        const records: DiagnosticEvent[] = [];
        let encodedByteLength = 2; // JSON array brackets; commas are counted below.
        let truncated = false;
        for (const { event } of matches) {
          const bytes = utf8.encode(JSON.stringify(event)).byteLength + (records.length === 0 ? 0 : 1);
          if (records.length >= query.limit || encodedByteLength + bytes > BYTE_LIMIT) {
            truncated = true;
            break;
          }
          records.push(Object.freeze({ ...event }));
          encodedByteLength += bytes;
        }
        return { records: Object.freeze(records), encodedByteLength, truncated };
      } catch { this.fail(); throw new Error("diagnostic sink unavailable"); }
    });
  }

  droppedCounts(): Readonly<Record<DiagnosticLevel, number>> {
    return Object.freeze({ ...this.dropped });
  }

  async persistShutdownSummary(summary: ShutdownSummary, active: () => boolean = () => true): Promise<void> {
    await this.flush();
    if (!this.available) throw new Error("diagnostic sink unavailable");
    const persistence = Object.fromEntries((Object.entries(summary.persistence) as [UnitId,
      ShutdownSummary["persistence"][UnitId]][]).map(([unit, status]) => [unit, status?.kind === "failed"
      ? { ...status, reason: "checkpoint operation failed" } : status]));
    const record = { ...summary, persistence, reasons: summary.reasons.map((reason) =>
      /^(mailboxDrain|sideEffectFinalization|finalCheckpoint|workerClose):(failed:operationFailed|deadlineExceeded|remainingInputs|remainingBatches|unconfirmedNotifications|unsavedUnits|remainingWorkers)$/.test(reason)
        ? reason : "shutdown incomplete") };
    await this.serial(async () => {
      try {
        if (!active()) throw new Error("shutdown summary deadline exceeded");
        await this.fileSystem.mkdir(this.directory);
        await this.replaceFile(join(this.directory, "shutdown-summary.json"), JSON.stringify(record), active);
      } catch {
        this.fail();
        throw new Error("diagnostic sink unavailable");
      }
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fileOperation.then(operation);
    this.fileOperation = result.then(() => {}, () => {});
    return result;
  }

  private async replaceFile(path: string, content: string, active: () => boolean = () => true): Promise<void> {
    const temporary = `${path}.tmp`;
    try {
      if (!active()) throw new Error("replacement deadline exceeded");
      await this.fileSystem.writeFile(temporary, content);
      if (!active()) throw new Error("replacement deadline exceeded");
      await this.fileSystem.rename(temporary, path);
    } catch (error) {
      try { await this.fileSystem.unlink(temporary); } catch { /* preserve the original failure and file */ }
      throw error;
    }
  }

  private drop(level: DiagnosticLevel, reason: "itemLimit" | "byteLimit" | "sinkUnavailable"): DiagnosticSinkResult {
    this.dropped[level] += 1;
    if (reason !== "sinkUnavailable") {
      this.overflowPending = true;
      this.scheduleFlush();
    }
    return { kind: "dropped", reason, level, count: this.dropped[level] };
  }

  private scheduleFlush(): void {
    if (this.flushing != null) return;
    queueMicrotask(() => { void this.flush(); });
  }

  private report(reason: "diagnosticSinkFailed" | "diagnosticQueueOverflow"): void {
    if (this.reporting) return;
    this.reporting = true;
    try {
      this.reportFailure(completeDiagnostic({ level: "ERROR", component: "diagnosticSink", reason,
        count: Object.values(this.dropped).reduce((sum, count) => sum + count, 0) },
      { wallTimeMs: this.readWallTime(), monotonicMs: 0 }, "diagnosticSink"));
    } catch { /* the fallback must not cause another sink failure */ }
    finally { this.reporting = false; }
  }

  private reportOverflow(): void {
    if (!this.overflowPending) return;
    this.overflowPending = false;
    this.report("diagnosticQueueOverflow");
  }

  private fail(): void {
    if (!this.available) return;
    this.available = false;
    for (const entry of this.queue.splice(0)) this.dropped[entry.event.level] += entry.occurrences;
    this.queuedBytes = 0;
    this.report("diagnosticSinkFailed");
  }

  private async prune(now: number): Promise<void> {
    // ponytail: scan retained daily files (100 MiB ceiling); stream them if measured sink cost requires it.
    const candidates = (await this.fileSystem.files(this.directory))
      .filter((file) => /^diagnostics-\d{4}-\d{2}-\d{2}\.jsonl(?:\.tmp)?$/.test(file.name)
        || file.name === "shutdown-summary.json.tmp")
      .sort((left, right) => Number(right.name.endsWith(".tmp")) - Number(left.name.endsWith(".tmp"))
        || left.name.localeCompare(right.name));
    const files: { name: string; size: number; timestamp: number }[] = [];
    let cleanupFailed = false;
    for (const file of candidates) {
      const path = join(this.directory, file.name);
      if (file.name.endsWith(".tmp")) {
        // Serialized maintenance never observes a live replacement tmp from this sink.
        try { await this.fileSystem.unlink(path); }
        catch {
          cleanupFailed = true;
          files.push({ name: file.name, size: file.size, timestamp: -Infinity });
        }
        continue;
      }
      const content = await this.fileSystem.readFile(path);
      const records: DiagnosticEvent[] = [];
      for (const line of content.split("\n")) {
        if (utf8.encode(`${line}\n`).byteLength > LINE_LIMIT) continue;
        try {
          const event = parsedEvent(JSON.parse(line));
          if (event != null && now - event.timestamp <= RETENTION_MS) records.push(event);
        } catch { /* incomplete/invalid records cannot become diagnostics */ }
      }
      if (records.length === 0) { await this.fileSystem.unlink(path); continue; }
      const compacted = compactRecords(records);
      const retained = compacted.map((event) => lineFor(event).line).join("");
      if (retained !== content && !cleanupFailed) await this.replaceFile(path, retained);
      files.push({ name: file.name, size: retained === content || cleanupFailed ? file.size : utf8.encode(retained).byteLength,
        timestamp: compacted.reduce((oldest, event) => Math.min(oldest, event.timestamp), Infinity) });
    }
    files.sort((left, right) => left.timestamp - right.timestamp || left.name.localeCompare(right.name));
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= RETENTION_BYTES) break;
      if (file.name.endsWith(".tmp")) continue; // Failed above; still counted, never treated as reclaimed.
      await this.fileSystem.unlink(join(this.directory, file.name));
      total -= file.size;
    }
    if (cleanupFailed) throw new Error("diagnostic temporary cleanup failed");
  }
}

function projectParserDiagnostic(parser: ParserDiagnostic, runId: string, timestamp: number): ParserDiagnosticProjection {
  const reason = parserReasons.find((candidate) => candidate === parser.reason);
  if (reason == null || !Number.isFinite(timestamp)) throw new Error("unsupported parser diagnostic");
  return {
    event: completeDiagnostic({ level: "WARN", component: "parser", reason, inputId: parser.inputId },
      { wallTimeMs: timestamp, monotonicMs: 0 }, runId),
    encodedByteLength: parser.encodedByteLength,
    expandedByteLength: parser.expandedByteLength,
  };
}

export { PersistentDiagnosticSink, projectParserDiagnostic };
export type { DiagnosticFile, DiagnosticFileSystem };
