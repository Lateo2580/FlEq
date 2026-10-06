import { promises as disk, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import type { CheckpointMeasurement, P2HostObservation } from "../../contracts/p2-eew-e01.types";
import type { ClockReading, PersistenceStatus, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import type { ExecutionPlace, OwnerReply } from "../../contracts/p3-execution-split.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import type { DiagnosticFileSystem } from "../../src/checkpoint/persistent-diagnostic-sink";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { OwnerHost } from "../../src/runtime/owner-host";
import { completeDiagnostic } from "../../src/runtime/runtime-diagnostic";
import { executionPlaces } from "../../src/runtime/unit-coverage";
import { fixtureDriver, fixtureState, recordingNotificationAdapter, stringCodec } from "../checkpoint-shutdown/runtime-fixture";
import { eewEnvelope } from "../notification-delivery/delivery-fixture";
import { envelope, harnessedRoot, idleChannels, manualAdapter, startHarness, submit } from "./owner-harness";
import type { Harness } from "./owner-harness";

describe("P3-C4-T03 contractBoundary / AC04(1): the full parse span of an owner input", () => {
  it("with the measurement mark the parse span lies inside decode; without it both fields are null; the marks keep their shape", async () => {
    const directory = await disk.mkdtemp(join(tmpdir(), "fleq-c4-t03-"));
    const vpws50 = readFileSync("test/fixtures/15_18_01_250630_VPWS50.xml");
    const run = (measured: boolean) => {
      const replies: OwnerReply[] = [];
      const owner = new OwnerHost({ start: { place: "weatherCurrent", stateDirectory: join(directory, String(measured)),
        publisherTimeOriginMs: performance.timeOrigin, measured, inputHeap: false }, units: linkedUnitTable, codecs: linkedUnitCodecs,
      fileSystem: nodeCheckpointFileSystem(), sharedNow: () => performance.timeOrigin + performance.now(),
      reply: (reply) => { replies.push(reply); }, fail: (error) => { throw error; } });
      const at = { wallTimeMs: 1_751_270_000_000, monotonicMs: performance.now() };
      owner.handle({ kind: "restore", runId: "t03", clock: at, sharedMs: performance.timeOrigin + performance.now() });
      owner.handle({ kind: "input", clock: at, sharedMs: performance.timeOrigin + performance.now(),
        envelope: envelope("t03", "VPWS50", "vpws50", vpws50, at) });
      const done = replies.at(-1);
      if (done?.kind !== "inputDone" || done.decode == null) throw new Error("inputDone with decode expected");
      return done;
    };
    try {
      const measured = run(true);
      const { startedMonotonicMs, endedMonotonicMs, xmlParseStartedMonotonicMs, xmlParseEndedMonotonicMs } = measured.decode!;
      if (xmlParseStartedMonotonicMs == null || xmlParseEndedMonotonicMs == null) throw new Error("parse span missing");
      expect([startedMonotonicMs, xmlParseStartedMonotonicMs, xmlParseEndedMonotonicMs, endedMonotonicMs])
        .toEqual([startedMonotonicMs, xmlParseStartedMonotonicMs, xmlParseEndedMonotonicMs, endedMonotonicMs].sort((a, b) => a - b));
      const plain = run(false);
      expect([plain.decode!.xmlParseStartedMonotonicMs, plain.decode!.xmlParseEndedMonotonicMs]).toEqual([null, null]);
      const shape = (reply: typeof measured) => Object.entries(reply.marks).map(([key, value]) => [key, value == null]).sort();
      expect(shape(measured)).toEqual(shape(plain));
    } finally { await disk.rm(directory, { recursive: true, force: true }); }
  });
});

// TEST-PATH (2) をメモリ上の filesystem で動かす。製品が書いた byte はすべて試験から見える。
function memory() {
  const checkpoints = new Map<string, Uint8Array>();
  const logs = new Map<string, string>();
  const checkpoint: CheckpointFileSystem = {
    unlinkSync(path) { checkpoints.delete(path); },
    readFile(path) { return checkpoints.get(path) ?? null; },
    async mkdir() {},
    async open(path) {
      checkpoints.set(path, new Uint8Array());
      return { async write(data) { checkpoints.set(path, data.slice()); }, async sync() {}, async close() {} };
    },
    async rename(from, to) { checkpoints.set(to, checkpoints.get(from)!); checkpoints.delete(from); },
    async syncDirectory() {},
  };
  const diagnostic: DiagnosticFileSystem = {
    async mkdir() {},
    async readLastByte(path) { return Buffer.from(logs.get(path) ?? "").at(-1) ?? null; },
    async appendFile(path, data) { logs.set(path, (logs.get(path) ?? "") + data); },
    async writeFile(path, data) { logs.set(path, data); },
    async rename(from, to) { logs.set(to, logs.get(from)!); logs.delete(from); },
    async readFile(path) { return logs.get(path) ?? ""; },
    async files() { return [...logs].map(([path, content]) => ({ name: basename(path), size: Buffer.byteLength(content), mtimeMs: Date.now() })); },
    async unlink(path) { logs.delete(path); },
  };
  return { checkpoint, diagnostic, logs };
}

type Measured = Extract<P2HostObservation, { kind: "checkpointGrant" | "writeCount" | "shutdownSummaryWrite" | "notificationAdoption" }>;

// 測定成果物（観測の書出し）は、host-launcher と同じく製品の包みを通らない生の filesystem で同じ診断 dir に書く。
async function measuredRuntime(measured = true, clock?: () => ClockReading) {
  const files = memory();
  const observed: Measured[] = [];
  const artifact = join(tmpdir(), "fleq-c4-t05-virtual", "diagnostics", "host-obs.jsonl");
  const measurements: CheckpointMeasurement[] = [];
  const driver = fixtureDriver();
  const directory = join(tmpdir(), "fleq-c4-t05-virtual");
  const h = harnessedRoot({ appName: "p2", legacyAppName: "v2", stateDirectory: join(directory, "state"),
    legacyStateDirectory: join(directory, "legacy"), diagnosticDirectory: join(directory, "diagnostics") },
  { "U-E": stringCodec("U-E"), "U-W": stringCodec("U-W"), "U-F": stringCodec("U-F") }, {
    ...(clock == null ? {} : { clock }),
    notificationAdapter: recordingNotificationAdapter(), checkpointFileSystem: files.checkpoint, diagnosticFileSystem: files.diagnostic,
    runtimeCalls: driver.calls, owners: { measured }, onMeasurements: (batch) => { measurements.push(...batch); },
    ...(measured ? { measure: (observation: Measured) => {
      observed.push(observation);
      void files.diagnostic.appendFile(artifact, `${JSON.stringify(observation)}\n`);
    } } : {}) });
  await startHarness(h, "t05");
  return { h, files, observed, measurements, artifact, update: (state: RuntimeState) => driver.update(h, state, h.clock()) };
}

const pending = (generation: number, dirtySince: number): PersistenceStatus => ({ kind: "pending", currentGeneration: generation,
  savedGeneration: null, savedCapturedAt: null, savedAckAt: null, dirtySince });
const dirtyAll = () => fixtureState({ "U-E": "eew", "U-W": "weather", "U-F": "series" },
  { "U-E": pending(1, 0), "U-W": pending(1, 1), "U-F": pending(1, 2) }, "t05");
const dirtySeries = () => fixtureState({ "U-F": "series" }, { "U-F": pending(1, 0) }, "t05");

// 期限の来た権が無くなるまで権を出す（返信はすべて届ける）。
async function saveAll(h: Harness): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const before = h.sent.length;
    const released = h.root.driveCheckpoint();
    await h.settle();
    await released;
    if (h.sent.length === before) return;
  }
}

const rows = (observed: readonly Measured[]) => observed.flatMap((o) => o.kind === "writeCount" ? [o] : []);
const ownedBy = (place: ExecutionPlace | "publisher", m: CheckpointMeasurement) =>
  Object.entries(executionPlaces).some(([unit, owner]) => owner === place && unit === m.unit);

describe("P3-C4-T05 contractBoundary / AC04, AC05: E14 and E15 observations on fake file systems", () => {
  it("(1)(2) write counts per thread once, confirmed and matching the measurements and the diagnostic records; one grant row per write right in order", async () => {
    const { h, files, observed, measurements, artifact, update } = await measuredRuntime();
    await update(dirtyAll());
    await saveAll(h);
    h.root.enqueueDiagnostic(completeDiagnostic({ level: "WARN", component: "test", reason: "mailboxStalled", count: 1, durationMs: 1 },
      h.clock(), "t05"));
    await h.root.shutdownRuntime(0, h.clock());

    const counts = rows(observed);
    expect(counts.map((row) => [row.thread, row.confirmed])).toEqual([["urgent", true], ["weatherCurrent", true], ["deferred", true], ["publisher", true]]);
    for (const row of counts.filter((item) => item.thread !== "publisher")) {
      const writes = measurements.filter((m) => m.stage === "write" && ownedBy(row.thread, m));
      expect(writes.length, row.thread).toBeGreaterThan(0);
      expect(row.counts, row.thread).toEqual({ tmp: { count: writes.length, bytes: writes.reduce((sum, m) => sum + m.bytes, 0) },
        checkpoint: { count: 0, bytes: 0 }, diagnosticLog: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } });
    }
    const publisher = counts.find((row) => row.thread === "publisher")!.counts;
    const logs = [...files.logs].filter(([path]) => basename(path).startsWith("diagnostics-")).map(([, text]) => text);
    const logBytes = logs.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    expect(logBytes).toBeGreaterThan(0);
    expect(publisher.diagnosticLog).toEqual({ count: logs.join("").split("\n").length - 1, bytes: logBytes });
    // 測定成果物の write（観測の書出し）は同じ診断 dir にあっても数えない。
    expect(Buffer.byteLength(files.logs.get(artifact) ?? "")).toBeGreaterThan(0);
    // 終了要約は一時 file を経て置き換える。それ以外の write は無い。
    expect(publisher.tmp.count).toBeGreaterThan(0);
    const summaries = observed.flatMap((o) => o.kind === "shutdownSummaryWrite" ? [o.bytes] : []);
    expect(publisher.tmp).toEqual({ count: summaries.length, bytes: summaries.reduce((sum, bytes) => sum + bytes, 0) });
    expect([publisher.checkpoint, publisher.other]).toEqual([{ count: 0, bytes: 0 }, { count: 0, bytes: 0 }]);

    const grants = observed.flatMap((o) => o.kind === "checkpointGrant" ? [o] : []);
    const sent = h.sent.flatMap(({ request }) => request.kind === "checkpointGrant" ? [request.grantId] : []);
    expect(grants.map((grant) => grant.grantId)).toEqual(sent);
    const replies = new Map(h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [[reply.grantId, reply]] : []));
    for (const grant of grants) {
      expect(grant.dirtyObservedMonotonicMs).not.toBeNull();
      const order = [grant.dirtyObservedMonotonicMs!, grant.grantSentMonotonicMs, grant.ownerStartedMonotonicMs, grant.doneReceivedMonotonicMs];
      expect(order, grant.grantId).toEqual([...order].sort((a, b) => a - b));
      expect(grant.attemptIds).toEqual([...new Set(replies.get(grant.grantId)!.measurements.map((m) => m.attemptId))]);
    }

    // 印が無いと owner は時刻も write も取らない。
    const plain = await measuredRuntime(false);
    await plain.update(dirtyAll());
    await saveAll(plain.h);
    const dones = plain.h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply] : []);
    expect(dones.length).toBeGreaterThan(0);
    expect(dones.map((reply) => [reply.grantStartedMs, reply.writeCounts])).toEqual(dones.map(() => [null, null]));
    await plain.h.root.shutdownRuntime(0, plain.h.clock());
    expect(plain.observed).toEqual([]);
  });

  // 最終保存の段は打ち切られず、終了まで未返信の権だけが残る形: 権の返信を保留した owner を unresponsive にして終了の段から外す
  // （外された owner が持つ権は待たずに最終保存の段を終える、P3-C3B-AC03）。
  it("(4) a write right still unanswered at the end, with the final save stage not cut, leaves only that owner unconfirmed", async () => {
    const skew = { ms: 0 };
    const { h, observed, update } = await measuredRuntime(true, () => ({ wallTimeMs: 1_800_000_000_000 + performance.now() + skew.ms,
      monotonicMs: performance.now() + skew.ms }));
    await update(dirtySeries());
    h.hold((_place, reply) => reply.kind === "checkpointDone");
    void h.root.driveCheckpoint();
    await h.settle();
    expect(h.held).toHaveLength(1);
    h.holdRequests((place, request) => place === "deferred" && request.kind === "deadline");
    h.root.tick(h.clock());
    await h.settle();
    skew.ms += 6_000;
    const summary = await h.root.shutdownRuntime(0, h.clock());
    expect(summary.reasons).not.toContain("finalCheckpoint:deadlineExceeded");
    expect(rows(observed).map((row) => [row.thread, row.confirmed]))
      .toEqual([["urgent", true], ["weatherCurrent", true], ["deferred", false], ["publisher", true]]);
  });

  it("(4) the held reply answered during the stop, with the final save and the exit done, is confirmed with its write", async () => {
    const { h, observed, measurements, update } = await measuredRuntime();
    await update(dirtySeries());
    const release = h.hold((_place, reply) => reply.kind === "checkpointDone");
    void h.root.driveCheckpoint();
    await h.settle();
    expect(h.held).toHaveLength(1);
    const stopping = h.root.shutdownRuntime(0, h.clock());
    await h.settle();
    release();
    h.release();
    await stopping;
    const writes = measurements.filter((m) => m.stage === "write" && m.unit === "U-F");
    expect(writes).toHaveLength(1);
    expect(rows(observed).find((row) => row.thread === "deferred")).toMatchObject({ confirmed: true,
      counts: { tmp: { count: 1, bytes: writes[0].bytes } } });
  });
});

describe("P3-C4-T11 contractBoundary / AC13(4)(5): the owner heap on replies and the notification adoption", () => {
  const now = { wallTimeMs: 1_713_363_299_001, monotonicMs: 1 };
  async function runtime(owners: Readonly<{ measured: boolean; inputHeap: boolean }>) {
    const directory = await disk.mkdtemp(join(tmpdir(), "fleq-c4-t11-"));
    const observed: Measured[] = [];
    const h = harnessedRoot({ appName: "p2", legacyAppName: "v2", stateDirectory: join(directory, "state"), legacyStateDirectory: join(directory, "legacy"),
      diagnosticDirectory: join(directory, "diagnostics") }, linkedUnitCodecs, { clock: () => now, notificationAdapter: manualAdapter().adapter, owners,
      ...(owners.measured ? { measure: (observation: Measured) => { observed.push(observation); } } : {}) });
    return { h, observed, cleanup: async () => { await h.root.diagnostics.flush(); await disk.rm(directory, { recursive: true, force: true }); } };
  }
  const adoptions = (observed: readonly Measured[]) => observed.flatMap((o) => o.kind === "notificationAdoption" ? [o] : []);

  it("deadlineDone carries the heap with the mark, inputDone only with the inputHeap mark too; without the mark both are null", async () => {
    for (const [measured, inputHeap] of [[true, true], [true, false], [false, false]] as const) {
      const { h, cleanup } = await runtime({ measured, inputHeap });
      try {
        await startHarness(h, "t11", now);
        await submit(h, eewEnvelope("t11", now));
        h.root.tick(now);
        await h.settle();
        const heaps = (kind: "deadlineDone" | "inputDone") => h.delivered.flatMap(({ reply }) => reply.kind === kind ? [reply.heap != null] : []);
        expect([heaps("deadlineDone").length > 0, heaps("inputDone").length > 0]).toEqual([true, true]);
        expect([new Set(heaps("deadlineDone")), new Set(heaps("inputDone"))]).toEqual([new Set([measured]), new Set([measured && inputHeap])]);
      } finally { await cleanup(); }
    }
  });

  it("one adoption row per reservation reply: sent ≤ reply ≤ adapter start; a reservation the owner did not adopt has no start", async () => {
    {
      const { h, observed, cleanup } = await runtime({ measured: true, inputHeap: false });
      try {
        await startHarness(h, "t11", now);
        await submit(h, eewEnvelope("t11", now));
        const rows = adoptions(observed);
        expect(rows.map((row) => [row.channel, row.adopted])).toEqual([["desktop", true], ["sound", true]]);
        for (const row of rows) {
          const order = [row.reservationSentMonotonicMs, row.replyReceivedMonotonicMs, row.attemptStartedMonotonicMs ?? -1];
          expect(order).toEqual([...order].sort((a, b) => a - b));
        }
      } finally { await cleanup(); }
    }
    // 予約と owner の採用の間に EEW が取り消され、owner はどちらも採用しない（P3-C3A-T07 の (1) と同じ流れ）。
    const { h, observed, cleanup } = await runtime({ measured: true, inputHeap: false });
    try {
      await startHarness(h, "t11", now, false);
      await submit(h, eewEnvelope("t11", now));
      h.pause();
      h.root.mailbox.enqueue(envelope("t11", "VXSE43", "cancel", readFileSync("test/fixtures/37_01_03_240613_VXSE43.xml"), now, 2));
      h.root.pump();
      const release = h.hold((_place, reply) => reply.kind === "intentUpdateDone");
      h.root.dispatch({ kind: "notificationProbeCompleted", channels: idleChannels, clock: now });
      await h.settle();
      release();
      h.release();
      await h.settle();
      expect(adoptions(observed).map((row) => [row.adopted, row.attemptStartedMonotonicMs])).toEqual([[false, null], [false, null]]);
    } finally { await cleanup(); }
  });
});
