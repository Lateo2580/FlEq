import { describe, expect, it } from "vitest";
import { createSchedulerState, enqueueJob, foldCatalog, type TickerJob } from "../ticker-schedule";

function job(key: string, groupKey: string): TickerJob {
  return {
    key,
    groupKey,
    seq: 0,
    kind: "event",
    priority: "low",
    role: "info",
    category: null,
    subject: null,
    segments: [key],
    segmentEmphasis: [[]],
    runs: [{ startSegmentIndex: 0, endSegmentIndexExclusive: 1 }],
    runIndex: 0,
    segmentIndex: 0,
    retryCount: 0,
    deferUntil: null,
    deferKind: null,
    revisionAt: null,
    isCancellation: false,
    tipPolicy: null,
    tipHazards: [],
    surface: "none",
  };
}

describe("volcano replacement groups", () => {
  it("foldCatalog preserves one latest cancellation per volcano", () => {
    const folded = foldCatalog([
      job("sakurajima-cancel", "volcano:event:506"),
      job("kirishima-cancel", "volcano:event:503"),
      job("sakurajima-old", "volcano:event:506"),
    ]);
    expect(folded.map((item) => item.key)).toEqual(["sakurajima-cancel", "kirishima-cancel"]);
  });

  it("enqueueJob replaces only the live ticker from the same volcano", () => {
    const initial = createSchedulerState([]);
    const first = enqueueJob(initial, job("sakurajima-v1", "volcano:event:506"), 1);
    const replaced = enqueueJob(first, job("sakurajima-cancel", "volcano:event:506"), 2);
    const coexisting = enqueueJob(replaced, job("kirishima-cancel", "volcano:event:503"), 3);
    expect(coexisting.queue.map((item) => item.key)).toEqual(["sakurajima-cancel", "kirishima-cancel"]);
  });
});
