import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MailboxEnvelope } from "../../contracts/p2-shared-runtime.types";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";
import { harnessedRoot, startHarness } from "../execution-split/owner-harness";

import { fixtureState, fixtureDriver, recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
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
    const normal = harnessedRoot(config(path), {}, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: {
      drainMailbox: async () => { expect(normal.root.mailbox.stats(clock.monotonicMs).accepting).toBe(false); order.push("drain"); },
      finalizeBatchesAndSideEffects: async () => { order.push("finalize"); return { batches: 0, notificationAttempts: 0 }; },
      closeWorker: async () => { order.push("close"); },
    } });
    await startHarness(normal, "run", clock, false);
    expect((await normal.root.shutdownRuntime(7, clock)).code).toBe(0);
    expect(order).toEqual(["drain", "finalize", "close"]);
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 0, acceptedThroughSequence: 7, pendingInputs: 0, inFlightInputs: 0 });

    const dirty = fixtureState({ "U-F": "final" }, { "U-F": { kind: "pending",
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } });
    const driver = fixtureDriver();
    const unsaved = harnessedRoot(config(path), {}, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: driver.calls, clock: () => clock });
    await driver.update(unsaved, dirty, clock);
    const unsavedSummary = await unsaved.root.shutdownRuntime(7, clock);
    expect(unsavedSummary).toMatchObject({ code: 2, reasons: ["finalCheckpoint:unsavedUnits"],
      persistence: { "U-F": { currentGeneration: 1, savedGeneration: null } } });

    const mailboxBlocked = harnessedRoot(config(path), {}, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: fixtureDriver().calls, clock: () => clock });
    mailboxBlocked.root.mailbox.enqueue(pendingEnvelope());
    await startHarness(mailboxBlocked, "run", clock, false);
    expect((await mailboxBlocked.root.shutdownRuntime(7, clock))).toMatchObject({
      code: 3, pendingInputs: 1, reasons: ["mailboxDrain:remainingInputs"],
    });

    const batchBlocked = harnessedRoot(config(path), {}, { notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: { finalizeBatchesAndSideEffects: async () => { throw new Error("stuck"); } },
    });
    await startHarness(batchBlocked, "run", clock, false);
    expect((await batchBlocked.root.shutdownRuntime(7, clock)).code).toBe(3);

    const closeBlocked = harnessedRoot(config(path), {}, { notificationAdapter: recordingNotificationAdapter(),
      runtimeCalls: fixtureDriver().calls, clock: () => clock, shutdownHooks: { closeWorker: async () => { throw new Error("stuck"); } },
    });
    await startHarness(closeBlocked, "run", clock, false);
    expect((await closeBlocked.root.shutdownRuntime(7, clock))).toMatchObject({
      code: 4, reasons: ["workerClose:failed:operationFailed", "workerClose:remainingWorkers"],
    });
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 4, reasons: ["workerClose:failed:operationFailed", "workerClose:remainingWorkers"] });
  });

  it("P2-A3-T06 contractBoundary / AC06: config rejects old/new ownership collisions before startup", async () => {
    const path = await directory();
    const send = () => {};
    expect(() => new RuntimeCompositionRoot({ ...config(path), appName: "fleq" }, {}, { send, notificationAdapter: recordingNotificationAdapter() })).toThrow(/appName/);
    expect(() => new RuntimeCompositionRoot({ ...config(path),
      stateDirectory: join(path, "legacy") }, {}, { send, notificationAdapter: recordingNotificationAdapter() })).toThrow(/directories/);
  });
});
