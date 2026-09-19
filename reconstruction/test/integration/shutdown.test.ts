import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue, MailboxEnvelope, RuntimeState, UnitCodec } from "../../contracts/p2-shared-runtime.types";
import { RuntimeCompositionRoot } from "../../src/runtime/composition-root";

type EmptyUnits = Readonly<{}>;
type SaveUnits = Readonly<{ "U-F": Readonly<{ value: string }> }>;
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

const saved: RuntimeState<EmptyUnits> = { units: {}, persistence: {}, shutdown: "running" };

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
    let normal: RuntimeCompositionRoot<EmptyUnits>;
    normal = new RuntimeCompositionRoot<EmptyUnits>(config(path), {}, { clock: () => clock, shutdownHooks: {
      drainMailbox: async () => { expect(normal.mailbox.stats(clock.monotonicMs).accepting).toBe(false); order.push("drain"); },
      finalizeBatchesAndSideEffects: async () => { order.push("finalize"); return 0; },
      closeWorker: async () => { order.push("close"); },
    } });
    expect((await normal.shutdownRuntime(saved, 7, clock)).code).toBe(0);
    expect(order).toEqual(["drain", "finalize", "close"]);
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 0, acceptedThroughSequence: 7, pendingInputs: 0, inFlightInputs: 0 });

    const dirty = { units: {}, persistence: { "U-F": { kind: "pending" as const,
      currentGeneration: 1, savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } },
      shutdown: "running" as const };
    const unsaved = new RuntimeCompositionRoot<EmptyUnits>(config(path), {}, { clock: () => clock });
    const unsavedSummary = await unsaved.shutdownRuntime(dirty, 7, clock);
    expect(unsavedSummary).toMatchObject({ code: 2, reasons: ["unsaved:U-F"],
      persistence: { "U-F": { currentGeneration: 1, savedGeneration: null } } });

    const unitCodec: UnitCodec<SaveUnits["U-F"], JsonValue> = {
      schemaVersion: "shutdown-test-v1", encode: (unit) => ({ value: unit.value }),
      decode: (payload) => payload != null && typeof payload === "object" && !Array.isArray(payload)
        && "value" in payload && typeof payload.value === "string"
        ? { kind: "restored", state: { value: payload.value } }
        : { kind: "invalid", reason: "invalid" },
    };
    const noAck = new RuntimeCompositionRoot<SaveUnits>(config(path), { "U-F": unitCodec }, { clock: () => clock });
    const waiting: RuntimeState<SaveUnits> = { units: { "U-F": { value: "final" } }, persistence: {
      "U-F": { kind: "pending", currentGeneration: 1, savedGeneration: null,
        savedCapturedAt: null, savedAckAt: null, dirtySince: 0 },
    }, shutdown: "running" };
    expect(noAck.scheduleCheckpoint(waiting, clock, "run", {
      "U-F": { inputIds: ["input"], retryReason: "notRetry" },
    })?.request).not.toBeNull();
    expect((await noAck.shutdownRuntime(waiting, 7, clock))).toMatchObject({ code: 2,
      reasons: ["unsaved:U-F"] });

    const mailboxBlocked = new RuntimeCompositionRoot<EmptyUnits>(config(path), {}, { clock: () => clock });
    mailboxBlocked.mailbox.enqueue(pendingEnvelope());
    expect((await mailboxBlocked.shutdownRuntime(saved, 7, clock))).toMatchObject({
      code: 3, pendingInputs: 1, reasons: ["mailboxNotDrained"],
    });

    const batchBlocked = new RuntimeCompositionRoot<EmptyUnits>(config(path), {}, {
      clock: () => clock, shutdownHooks: { finalizeBatchesAndSideEffects: async () => { throw new Error("stuck"); } },
    });
    expect((await batchBlocked.shutdownRuntime(saved, 7, clock)).code).toBe(3);

    const closeBlocked = new RuntimeCompositionRoot<EmptyUnits>(config(path), {}, {
      clock: () => clock, shutdownHooks: { closeWorker: async () => { throw new Error("stuck"); } },
    });
    expect((await closeBlocked.shutdownRuntime(saved, 7, clock))).toMatchObject({
      code: 4, reasons: ["workerCloseTimedOut"],
    });
    expect(JSON.parse(await fileSystem.readFile(join(path, "diagnostics", "shutdown-summary.json"), "utf8")))
      .toMatchObject({ code: 4, reasons: ["workerCloseTimedOut"] });
  });

  it("P2-A3-T06 contractBoundary / AC06: config rejects old/new ownership collisions before startup", async () => {
    const path = await directory();
    expect(() => new RuntimeCompositionRoot<EmptyUnits>({ ...config(path), appName: "fleq" }, {})).toThrow(/appName/);
    expect(() => new RuntimeCompositionRoot<EmptyUnits>({ ...config(path),
      stateDirectory: join(path, "legacy") }, {})).toThrow(/directories/);
  });
});
