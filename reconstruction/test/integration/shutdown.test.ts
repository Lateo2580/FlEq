import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue, MailboxEnvelope, RuntimeState, UnitCodec } from "../../contracts/p2-shared-runtime.types";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";

import { fixtureState, fixtureDriver, stringCodec } from "../checkpoint-shutdown/runtime-fixture";
const temporary: string[] = [];
const clock = { wallTimeMs: 10_000, monotonicMs: 100 } as const;

async function directory(): Promise<string> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a3-shutdown-"));
  temporary.push(path);
  return path;
}

function config(path: string) {
  return { appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") } as const;
}

const saved = fixtureState();

function pendingEnvelope(): MailboxEnvelope {
  return {
    messageId: "pending", runId: "run", t0MonotonicMs: 0, enqueuedMonotonicMs: 0,
    priorityReason: "normal", payload: { kind: "parser", item: {
      inputId: "pending", inputSequence: 1, receivedAt: 0, origin: "replay", headType: "VPWS50",
      encoding: "utf-8", compression: null, encodedBody: new Uint8Array(), encodedByteLength: 0,
      headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "provided", value: "normal" },
    } },
  };
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true });
});

describe("P2 shutdown composition", () => {
  it("P2-A3-T06 acceptance / AC06: stage order produces only codes 0/2/3/4 and never 0 with unsaved state", async () => {
    const path = await directory();
    const order: string[] = [];
    let normal: RuntimeCompositionRoot;
    normal = new RuntimeCompositionRoot(config(path), {}, { runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: {
      drainMailbox: async () => { expect(normal.mailbox.stats(clock.monotonicMs).accepting).toBe(false); order.push("drain"); },
      finalizeBatchesAndSideEffects: async () => { order.push("finalize"); return { batches: 0, notificationAttempts: 0 }; },
      closeWorker: async () => { order.push("close"); },
    } });
    expect((await normal.shutdownRuntime(saved, 7, clock)).code).toBe(0);
    expect(order).toEqual(["drain", "finalize", "close"]);
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 0, acceptedThroughSequence: 7, pendingInputs: 0, inFlightInputs: 0 });

    const dirty = fixtureState({ "U-F": "final" }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } });
    const unsaved = new RuntimeCompositionRoot(config(path), {}, { runtimeCalls: fixtureDriver().calls, clock: () => clock });
    const unsavedSummary = await unsaved.shutdownRuntime(dirty, 7, clock);
    expect(unsavedSummary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"],
      persistence: { "U-F": { currentGeneration: 1, savedGeneration: null } } });

    const noAck = new RuntimeCompositionRoot(config(path), { "U-F": stringCodec("U-F") },
      { runtimeCalls: fixtureDriver().calls, clock: () => clock });
    const waiting = dirty;
    expect(noAck.scheduleCheckpoint(waiting, clock, "run", {
      "U-F": { inputIds: ["input"], retryReason: "notRetry" },
    })?.request).not.toBeNull();
    expect((await noAck.shutdownRuntime(waiting, 7, clock))).toMatchObject({ code: 2,
      reasons: ["finalCheckpoint:unsavedUnits"] });

    const mailboxBlocked = new RuntimeCompositionRoot(config(path), {}, { runtimeCalls: fixtureDriver().calls, clock: () => clock });
    mailboxBlocked.mailbox.enqueue(pendingEnvelope());
    expect((await mailboxBlocked.shutdownRuntime(saved, 7, clock))).toMatchObject({
      code: 3, pendingInputs: 1, reasons: ["mailboxDrain:remainingInputs"],
    });

    const batchBlocked = new RuntimeCompositionRoot(config(path), {}, {
      runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: { finalizeBatchesAndSideEffects: async () => { throw new Error("stuck"); } },
    });
    expect((await batchBlocked.shutdownRuntime(saved, 7, clock)).code).toBe(3);

    const closeBlocked = new RuntimeCompositionRoot(config(path), {}, {
      runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: { closeWorker: async () => { throw new Error("stuck"); } },
    });
    expect((await closeBlocked.shutdownRuntime(saved, 7, clock))).toMatchObject({
      code: 4, reasons: ["workerClose:failed:operationFailed", "workerClose:remainingWorkers"],
    });
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 4, reasons: ["workerClose:failed:operationFailed", "workerClose:remainingWorkers"] });
  });

  it("P2-A3-T06 contractBoundary / AC06: config rejects old/new ownership collisions before startup", async () => {
    const path = await directory();
    expect(() => new RuntimeCompositionRoot({ ...config(path), appName: "fleq" }, {})).toThrow(/appName/);
    expect(() => new RuntimeCompositionRoot({ ...config(path),
      stateDirectory: join(path, "legacy") }, {})).toThrow(/directories/);
  });
});
