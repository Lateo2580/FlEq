import { readFileSync } from "node:fs";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import type { ParserMailboxItem, ParserMailboxResult } from "../../contracts/p1-parser-boundary.types";
import type { MailboxCompletion, MailboxControl, MailboxEnvelope } from "../../contracts/p2-shared-runtime.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import { Mailbox } from "../../src/mailbox/mailbox";

function item(inputId: string, inputSequence: number, headType: string, encodedByteLength: number,
  operation: "normal" | "training" | "test" = "normal"): ParserMailboxItem {
  return {
    inputId, inputSequence, receivedAt: inputSequence, origin: "replay", headType,
    encoding: "utf-8", compression: null, encodedBody: new Uint8Array(), encodedByteLength,
    headTest: { kind: "provided", value: operation !== "normal" },
    envelopeStatus: { kind: "provided", value: operation },
  };
}

function parserEnvelope(mailboxItem: ParserMailboxItem, priorityReason: "eewCandidate" | "tsunamiCandidate" | "normal",
  enqueuedMonotonicMs = mailboxItem.inputSequence): MailboxEnvelope {
  return {
    messageId: mailboxItem.inputId, runId: "run", t0MonotonicMs: enqueuedMonotonicMs,
    enqueuedMonotonicMs, priorityReason, payload: { kind: "parser", item: mailboxItem },
  };
}

function controlEnvelope(messageId: string, control: MailboxControl, enqueuedMonotonicMs: number): MailboxEnvelope {
  return { messageId, runId: "run", t0MonotonicMs: enqueuedMonotonicMs, enqueuedMonotonicMs,
    priorityReason: "control", payload: { kind: "control", control } };
}

const parserResult = { kind: "rejected", diagnostic: {
  inputId: "unused", reason: "xmlInvalid", encodedByteLength: 0, expandedByteLength: null,
  operation: { kind: "undetermined", sources: {} },
} } satisfies ParserMailboxResult;

function completion(envelope: MailboxEnvelope, startedMonotonicMs: number, completedMonotonicMs: number): MailboxCompletion {
  const encodedByteLength = envelope.payload.kind === "parser" ? envelope.payload.item.encodedByteLength
    : new TextEncoder().encode(JSON.stringify(envelope.payload)).byteLength;
  return envelope.payload.kind === "parser" ? {
    kind: "parser", messageId: envelope.messageId, runId: envelope.runId, encodedByteLength,
    startedMonotonicMs, completedMonotonicMs, inputId: envelope.payload.item.inputId,
    inputSequence: envelope.payload.item.inputSequence,
    result: { ...parserResult, diagnostic: { ...parserResult.diagnostic, inputId: envelope.payload.item.inputId } },
  } : {
    kind: "control", messageId: envelope.messageId, runId: envelope.runId, encodedByteLength,
    startedMonotonicMs, completedMonotonicMs, control: envelope.payload.control,
  };
}

function fixture(path: string, headType: string, inputSequence: number): ParserMailboxItem {
  const entered = ingestXmlData({ kind: "replay", inputId: path, inputSequence, receivedAt: inputSequence,
    origin: "replay", headType, body: readFileSync(path) });
  if (entered.kind !== "accepted") throw new Error(`fixture rejected: ${path}`);
  return entered.item;
}

describe("P2 mailbox", () => {
  it("P2-A2-T01 contractBoundary / AC01: below/exact/over limits and take/transfer/complete accounting", async () => {
    const { port1, port2 } = new MessageChannel();
    try {
      for (const scope of ["normal", "reserved", "total"] as const) {
        for (const dimension of ["items", "bytes"] as const) {
          const mailbox = new Mailbox();
          const accepted: MailboxEnvelope[] = [];
          let totalBytes = 0;
          const clock = 10_000;
          const admit = (bytes: number, reserved: boolean) => {
            const envelope = parserEnvelope(item(`input-${accepted.length}`, accepted.length,
              reserved ? "VXSE45" : "VPWS50", bytes,
              reserved ? "normal" : (["normal", "training", "test"] as const)[accepted.length % 3]),
            reserved ? "eewCandidate" : "normal");
            const result = mailbox.enqueue(envelope);
            expect(result.kind).toBe("accepted");
            accepted.push(envelope);
            totalBytes += bytes;
            expect(result.stats).toMatchObject({ pendingItems: accepted.length, pendingBytes: totalBytes,
              inFlightItems: 0, inFlightBytes: 0, accepted: accepted.length, rejected: 0,
              highWaterItems: accepted.length, highWaterBytes: totalBytes, limitViolations: 0 });
          };
          if (dimension === "items") {
            const below = scope === "normal" ? 119 : scope === "reserved" ? 7 : 127;
            for (let index = 0; index < below; index += 1)
              admit(1, scope === "reserved" || scope === "total" && index >= 120);
          } else {
            // Mailbox accounting uses declared parser bytes; no fabricated XML is decoded.
            if (scope !== "reserved") {
              admit(7 * 1024 * 1024, false);
              admit(7 * 1024 * 1024 - (scope === "normal" ? 1 : 0), false);
            }
            if (scope !== "normal") admit(2 * 1024 * 1024 - 1, true);
          }
          const itemLimit = scope === "normal" ? 120 : scope === "reserved" ? 8 : 128;
          const byteLimit = (scope === "normal" ? 14 : scope === "reserved" ? 2 : 16) * 1024 * 1024;
          expect(dimension === "items" ? accepted.length : totalBytes)
            .toBe((dimension === "items" ? itemLimit : byteLimit) - 1);
          admit(1, scope !== "normal");
          expect(dimension === "items" ? accepted.length : totalBytes)
            .toBe(dimension === "items" ? itemLimit : byteLimit);
          const peakItems = accepted.length;
          const peakBytes = totalBytes;
          expect(mailbox.enqueue(parserEnvelope(item("overflow", 999, scope === "normal" ? "VPWS50" : "VXSE45", 1),
            scope === "normal" ? "normal" : "eewCandidate"))).toMatchObject({
            kind: "rejected", reason: dimension === "items" ? "itemLimit" : "byteLimit",
            stats: { pendingItems: peakItems, pendingBytes: peakBytes, rejected: 1, limitViolations: 0 },
          });
          for (let index = 0; index < peakItems; index += 1) {
            const started = clock + index * 2;
            const next = mailbox.takeNext(started);
            if (next == null || next.payload.kind !== "parser") throw new Error("missing parser");
            const bytes = next.payload.item.encodedByteLength;
            const expected = { pendingItems: peakItems - index - 1, pendingBytes: totalBytes - bytes,
              inFlightItems: 1, inFlightBytes: bytes, completed: index,
              highWaterItems: peakItems, highWaterBytes: peakBytes, limitViolations: 0 };
            const taken = mailbox.stats(started);
            expect(taken).toMatchObject(expected);
            expect(taken.pendingItems + taken.inFlightItems).toBe(peakItems - index);
            expect(taken.pendingBytes + taken.inFlightBytes).toBe(totalBytes);
            const delivered = once(port2, "message");
            port1.postMessage(next);
            const [received] = await delivered;
            expect(received).toEqual(next);
            const transferred = mailbox.stats(started);
            expect(transferred).toEqual(taken);
            expect(transferred.pendingItems + transferred.inFlightItems).toBe(peakItems - index);
            expect(transferred.pendingBytes + transferred.inFlightBytes).toBe(totalBytes);
            const after = mailbox.complete(completion(next, started, started + 1));
            totalBytes -= bytes;
            expect(after).toMatchObject({ pendingItems: peakItems - index - 1, pendingBytes: totalBytes,
              inFlightItems: 0, inFlightBytes: 0, completed: index + 1,
              highWaterItems: peakItems, highWaterBytes: peakBytes, limitViolations: 0 });
            expect(after.pendingItems + after.inFlightItems).toBe(peakItems - index - 1);
            expect(after.pendingBytes + after.inFlightBytes).toBe(totalBytes);
          }
        }
      }
      // A real UTF-8 control payload shares reservation bytes with emergency data.
      const mailbox = new Mailbox();
      const ack = controlEnvelope("保存ack", { kind: "checkpointResult", clock: { wallTimeMs: 0, monotonicMs: 0 },
        result: { kind: "acknowledged", attemptId: "保存", unit: "U-E", generation: 1, ackAt: 0, encodedByteLength: 1 } }, 0);
      const ackBytes = new TextEncoder().encode(JSON.stringify(ack.payload)).byteLength;
      const data = parserEnvelope(item("data", 0, "VXSE45", 2 * 1024 * 1024 - ackBytes), "eewCandidate");
      mailbox.enqueue(data);
      expect(mailbox.takeNext(1)).toBe(data);
      expect(mailbox.enqueue(ack)).toMatchObject({ kind: "accepted", stats: { pendingBytes: ackBytes,
        inFlightBytes: 2 * 1024 * 1024 - ackBytes, highWaterBytes: 2 * 1024 * 1024 } });
      expect(mailbox.takeNext(2)).toBe(ack);
      const beforeTransfer = mailbox.stats(2);
      expect(beforeTransfer).toMatchObject({ pendingItems: 0, pendingBytes: 0,
        inFlightItems: 2, inFlightBytes: 2 * 1024 * 1024, inFlightControlMessageIds: ["保存ack"] });
      const delivered = once(port2, "message");
      port1.postMessage(ack);
      expect((await delivered)[0]).toEqual(ack);
      expect(mailbox.stats(2)).toEqual(beforeTransfer);
      expect(mailbox.complete(completion(ack, 2, 3))).toMatchObject({ inFlightItems: 1,
        inFlightBytes: 2 * 1024 * 1024 - ackBytes, completed: 1, limitViolations: 0 });
      expect(mailbox.complete(completion(data, 1, 4))).toMatchObject({
        pendingItems: 0, pendingBytes: 0, inFlightItems: 0, inFlightBytes: 0,
        completed: 2, highWaterItems: 2, highWaterBytes: 2 * 1024 * 1024, limitViolations: 0 });
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("P2-A2-T02 acceptance / AC02: provisional 5s wait and 10s drain boundaries are observable", () => {
    const mailbox = new Mailbox();
    const first = parserEnvelope(item("first", 0, "VPWS50", 1), "normal", 0);
    mailbox.enqueue(first);
    expect(mailbox.stats(4_999).oldestPendingAgeMs).toBe(4_999);
    expect(mailbox.takeNext(5_000)).toBe(first);
    mailbox.complete(completion(first, 5_000, 5_001));
    mailbox.enqueue(parserEnvelope(item("pending", 2, "VPWS50", 1), "normal", 6_000));
    expect(mailbox.beginDrain(6_001).accepting).toBe(false);
    expect(mailbox.enqueue(parserEnvelope(item("late", 3, "VPWS50", 1), "normal", 6_002)))
      .toMatchObject({ kind: "rejected", reason: "draining", stats: { lastArrivalMonotonicMs: 6_002 } });
    const control = controlEnvelope("drain-control", { kind: "deadline",
      clock: { wallTimeMs: 0, monotonicMs: 6_003 } }, 6_003);
    expect(mailbox.enqueue(control).kind).toBe("accepted");
    expect(mailbox.takeNext(6_003)).toBe(control);
    mailbox.complete(completion(control, 6_003, 6_004));
    const pending = mailbox.takeNext(15_999);
    if (pending == null) throw new Error("pending item missing");
    expect(mailbox.complete(completion(pending, 15_999, 16_000))).toMatchObject({ pendingItems: 0, inFlightItems: 0 });
  });

  it("P2-A2-T03 contractBoundary / AC03: control and fixed priority in a known-operation synthetic sequence", () => {
    const mailbox = new Mailbox();
    const earlierTsunami = parserEnvelope(item("tsunami-old", 0, "VTSE41", 1), "normal");
    const normal = parserEnvelope(item("normal", 1, "VPWS50", 1), "normal");
    const laterTsunami = parserEnvelope(item("tsunami-new", 2, "VTSE41", 1), "tsunamiCandidate");
    const eew = parserEnvelope(item("eew", 3, "VXSE45", 1), "eewCandidate");
    const training = parserEnvelope(item("training", 4, "VXSE45", 1, "training"), "eewCandidate");
    const deadline = controlEnvelope("deadline", { kind: "deadline", clock: { wallTimeMs: 0, monotonicMs: 10 } }, 5);
    for (const envelope of [earlierTsunami, normal, laterTsunami, eew, training, deadline]) mailbox.enqueue(envelope);

    expect(mailbox.takeNext(10)).toBe(deadline);
    mailbox.complete(completion(deadline, 10, 11));
    expect(mailbox.takeNext(12)).toBe(eew);
    const shutdown = controlEnvelope("shutdown", { kind: "shutdownRequested", acceptedThroughSequence: 4,
      clock: { wallTimeMs: 0, monotonicMs: 13 } }, 13);
    mailbox.enqueue(shutdown);
    expect(mailbox.takeNext(13)).toBe(shutdown);
    mailbox.complete(completion(shutdown, 13, 14));
    expect(mailbox.takeNext(14)).toBeNull();
    mailbox.complete(completion(eew, 12, 15));
    for (const expected of [earlierTsunami, laterTsunami, normal, training]) {
      const next = mailbox.takeNext(16);
      expect(next).toBe(expected);
      if (next == null) throw new Error("priority item missing");
      mailbox.complete(completion(next, 16, 17));
    }
  });

  it("P2-A2-T04 regression / AC04: P1 item fields stay unchanged and envelope correlation survives completion", () => {
    const mailbox = new Mailbox();
    const mailboxItem = fixture("test/fixtures/77_01_01_240613_VXSE45.xml", "VXSE45", 1);
    expect(Object.keys(mailboxItem).sort()).toEqual([
      "compression", "encodedBody", "encodedByteLength", "encoding", "envelopeStatus", "headTest",
      "headType", "inputId", "inputSequence", "origin", "receivedAt",
    ]);
    const envelope = { ...parserEnvelope(mailboxItem, "eewCandidate", 20), runId: "run-04", t0MonotonicMs: 19 };
    mailbox.enqueue(envelope);
    expect(mailbox.takeNext(21)).toBe(envelope);
    expect(mailbox.complete({ ...completion(envelope, 21, 22), runId: "run-04" })).toMatchObject({
      pendingItems: 0, inFlightItems: 0, completed: 1,
    });
    expect(envelope).toMatchObject({ messageId: mailboxItem.inputId, runId: "run-04", t0MonotonicMs: 19, enqueuedMonotonicMs: 20,
      priorityReason: "eewCandidate", payload: { kind: "parser", item: { inputId: mailboxItem.inputId } } });
  });

  it("P2-A2-T04 regression / AC04: a repeated completion cannot release another colliding inventory entry", () => {
    for (const secondTake of [1_000, 1_001]) {
      const mailbox = new Mailbox();
      const control = controlEnvelope("duplicate", { kind: "deadline",
        clock: { wallTimeMs: 0, monotonicMs: 0 } }, 0);
      // Deliberate caller-precondition violations reproduce the review's failure.
      mailbox.enqueue({ ...parserEnvelope(item("parser-id", 0, "VPWS50", 1), "normal"), messageId: "duplicate" });
      mailbox.enqueue(control);
      mailbox.enqueue(control);
      mailbox.takeNext(1_000);
      mailbox.takeNext(secondTake);
      expect(mailbox.stats(1_001)).toMatchObject({ pendingItems: 1, inFlightItems: 2,
        inFlightControlMessageIds: ["duplicate", "duplicate"], completed: 0 });
      const done = completion(control, 1_000, 1_002);
      const afterFirst = mailbox.complete(done);
      expect(afterFirst).toMatchObject({ pendingItems: 1, inFlightItems: 1, completed: 1,
        lastProgressMonotonicMs: 1_002, inFlightControlMessageIds: ["duplicate"] });
      expect(mailbox.complete(done)).toEqual(afterFirst);
      expect(mailbox.complete(structuredClone(done))).toEqual(afterFirst);
      // A distinct later start can finish the remaining entry; no public token is invented.
      expect(mailbox.complete(completion(control, 1_001, 1_003))).toMatchObject({
        pendingItems: 1, inFlightItems: 0, completed: 2, lastProgressMonotonicMs: 1_003 });
    }
  });

  it("P2-A2-T05 regression / AC05: completion before the actual dispatch cannot release data or control", () => {
    for (const envelope of [
      parserEnvelope(item("parser", 0, "VPWS50", 1), "normal"),
      controlEnvelope("control", { kind: "deadline", clock: { wallTimeMs: 0, monotonicMs: 0 } }, 0),
    ]) {
      const mailbox = new Mailbox();
      mailbox.enqueue(envelope);
      expect(mailbox.takeNext(1_000)).toBe(envelope);
      expect(mailbox.takeNext(1_000)).toBeNull();
      const before = mailbox.stats(1_000);
      for (const [started, completed] of [[0, 1], [999, 1_001], [1_000, 999]]) {
        mailbox.complete(completion(envelope, started, completed));
        expect(mailbox.stats(1_000)).toEqual(before);
      }
      expect(mailbox.complete(completion(envelope, 1_000, 1_001))).toMatchObject({
        inFlightItems: 0, inFlightBytes: 0, completed: 1, lastProgressMonotonicMs: 1_001 });
    }
  });

  it("P2-A2-T03 corpusHistory / AC03: maximum O09 input remains in-flight while the EEW candidate waits", () => {
    const mailbox = new Mailbox();
    const maximum = parserEnvelope(fixture("test/fixtures/15_18_01_250630_VPWS50.xml", "VPWS50", 1), "normal", 1);
    const eew = parserEnvelope(fixture("test/fixtures/77_01_01_240613_VXSE45.xml", "VXSE45", 2), "eewCandidate", 2);
    mailbox.enqueue(maximum);
    expect(mailbox.takeNext(3)).toBe(maximum);
    mailbox.enqueue(eew);
    expect(mailbox.takeNext(4)).toBeNull();
    mailbox.complete(completion(maximum, 3, 5));
    expect(mailbox.takeNext(5)).toBe(eew);
  });

  it("P2-A2-T05 contractBoundary / AC05: read-only ages, deadline origin and separate arrival/response/progress", () => {
    const mailbox = new Mailbox();
    mailbox.enqueue(parserEnvelope(item("stuck-0", 0, "VPWS50", 1), "normal", 0));
    for (let second = 1; second <= 5; second += 1) {
      mailbox.enqueue(parserEnvelope(item(`stuck-${second}`, second, "VPWS50", 1), "normal", second * 1_000));
      mailbox.recordWorkerResponse(second * 1_000);
    }
    const atFive = mailbox.stats(5_000);
    expect(atFive).toMatchObject({ lastProgressMonotonicMs: 0, lastArrivalMonotonicMs: 5_000,
      lastWorkerResponseMonotonicMs: 5_000, oldestIncompleteAgeMs: 5_000 });
    expect(5_000 - atFive.lastProgressMonotonicMs!).toBe(5_000);
    expect(5_000 - atFive.lastWorkerResponseMonotonicMs!).toBe(0);
    expect(mailbox.stats(5_001)).toMatchObject({ accepted: 6, completed: 0, rejected: 0,
      lastProgressMonotonicMs: 0, oldestIncompleteAgeMs: 5_001 });
    expect(mailbox.takeNext(5_001)?.messageId).toBe("stuck-0");
    const beforeInvalid = mailbox.stats(5_001);
    mailbox.complete({ ...completion(parserEnvelope(item("wrong", 99, "VPWS50", 1), "normal"), 5_001, 5_002) });
    expect(mailbox.stats(5_002).lastProgressMonotonicMs).toBe(beforeInvalid.lastProgressMonotonicMs);

    const worker = new Mailbox();
    worker.recordWorkerResponse(0);
    expect(worker.stats(5_000)).toMatchObject({ lastWorkerResponseMonotonicMs: 0, lastProgressMonotonicMs: null,
      pendingItems: 0, inFlightItems: 0 });
    const deadlines = new Mailbox();
    deadlines.enqueue(controlEnvelope("only-deadline", { kind: "deadline",
      clock: { wallTimeMs: 10, monotonicMs: 2_000 } }, 1_000));
    expect(deadlines.stats(5_000)).toMatchObject({ lastProgressMonotonicMs: 2_000,
      nextDeadlineMonotonicMs: 2_000, oldestIncompleteAgeMs: 4_000 });
    deadlines.enqueue(parserEnvelope(item("later", 1, "VPWS50", 1), "normal", 7_000));
    const later = deadlines.stats(7_000);
    expect(later).toMatchObject({ lastProgressMonotonicMs: 2_000, lastArrivalMonotonicMs: 7_000,
      nextDeadlineMonotonicMs: 2_000, oldestPendingAgeMs: 6_000, oldestIncompleteAgeMs: 6_000 });
    expect(7_000 - later.lastProgressMonotonicMs!).toBe(5_000);
    deadlines.stats(20_000);
    expect(deadlines.stats(7_000)).toEqual(later);
    expect(deadlines.recordWorkerResponse(7_000)).toEqual({ ...later, lastWorkerResponseMonotonicMs: 7_000 });
  });
});
