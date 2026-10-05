import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import type { CheckpointFileSystem } from "../../src/checkpoint/checkpoint";
import { linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { recordingNotificationAdapter } from "../checkpoint-shutdown/runtime-fixture";
import { envelope, harnessedRoot, startHarness, submit } from "../execution-split/owner-harness";
import type { Harness } from "../execution-split/owner-harness";
import { readFileSync } from "node:fs";

const atTime = (xml: string, time: string) => xml.replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, `<ReportDateTime>${time}</ReportDateTime>`);
const vpww57 = readFileSync("test/fixtures/15_16_02_251222_VPWW57.xml", "utf8");
let sequence = 0;
const weather = (h: Harness, inputId: string, clock: { wallTimeMs: number; monotonicMs: number }, transform = (xml: string) => xml) =>
  submit(h, envelope("run", "VPWW57", inputId, Buffer.from(transform(vpww57)), clock, ++sequence));
// TEST-PATH (2): the publisher drives the save; the owner writes. A fresh directory per root.
async function drivenRoot(checkpointFileSystem: CheckpointFileSystem) {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a10-drive-"));
  directories.push(path);
  const now = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
  const clock = () => ({ ...now });
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs,
  { runtimeCalls, notificationAdapter: recordingNotificationAdapter(), clock, checkpointFileSystem });
  await startHarness(h, "run", clock());
  return { h, root: h.root, now, clock };
}

const runtimeCalls = { ...linkedRuntimeCalls, selectNotificationAttempt: (delivery: NotificationDeliveryState) =>
  ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }) };
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await fileSystem.rm(path, { recursive: true, force: true }); });

// P2-A10-AC12 (save driving): without a repeated reconciliation the unit stays uncertain and is never saved again.
it("P2-A10-T06 / AC12: driveCheckpoint reconciles an uncertain unit on each due tick until it is saved, then saves the next generation", async () => {
  const files = nodeCheckpointFileSystem();
  const sync = { calls: 0, fail: true };
  // The write's directory sync and the first reconciliation fail; the test then lets the due reconciliation succeed.
  const checkpointFileSystem = { ...files, async syncDirectory(directory: string) {
    sync.calls += 1;
    if (sync.fail) throw new Error("injected directory sync failure");
    return files.syncDirectory(directory);
  } };
  const { h, root, now, clock } = await drivenRoot(checkpointFileSystem);
  await weather(h, "15_16_02_251222_VPWW57", clock());
  const persistence = () => root.state.mirror["U-W"].persistence;

  await root.driveCheckpoint();
  expect(persistence().kind).toBe("uncertain"); // the write's directory sync failed
  await root.driveCheckpoint();
  expect(persistence().kind).toBe("uncertain"); // the first reconciliation failed too and set a backoff
  const reconciled = sync.calls;
  await root.driveCheckpoint();
  expect(sync.calls).toBe(reconciled); // before retryAfter nothing is called
  sync.fail = false;
  now.monotonicMs = root.checkpoint.retryAfter("U-W")!;
  await root.driveCheckpoint();
  expect(persistence()).toMatchObject({ kind: "saved", savedGeneration: 1 });

  await weather(h, "follow-up", clock(), (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"));
  await root.driveCheckpoint();
  expect(persistence()).toMatchObject({ kind: "saved", savedGeneration: 2 });
});

// A root with `ids` unsaved U-W generations, one input ID each (Hertz's P1-5 setup).
async function unsavedRoot(ids: number, checkpointFileSystem = nodeCheckpointFileSystem()) {
  const { h, root, now, clock } = await drivenRoot(checkpointFileSystem);
  for (let index = 0; index < ids; index++) {
    const time = new Date(Date.UTC(2020, 5, 22, 23, 0) + index * 60_000).toISOString().slice(0, 19);
    await weather(h, `unsaved-${index}`, clock(), (xml) => atTime(xml, `${time}+09:00`));
  }
  expect(root.state.mirror["U-W"].persistence.currentGeneration).toBe(ids);
  return { h, root, now };
}

// A10 Hertz P1-5: the correlation check matched unsaved input IDs pairwise (ids.some(...includes...)), 500,500 steps
// for 1,000 IDs. Since X4 the only correlation is the one a grant builds from the owner's ledger: it does no per-ID search.
it("P2-A10-T06 regression / AC12: building a 1,000-ID save correlation does no per-ID array search", async () => {
  const ids = 1_000;
  const { h, root } = await unsavedRoot(ids);
  // Counts the built-in array searches only; a hand-written nested loop would not show here.
  const searches = (["includes", "indexOf", "lastIndexOf", "find", "findIndex"] as const)
    .map((name) => vi.spyOn(Array.prototype, name));
  let counted = 0;
  try {
    const released = root.driveCheckpoint();
    h.flush();
    counted = searches.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    await h.settle();
    await released;
  } finally { searches.forEach((spy) => spy.mockRestore()); }
  expect(counted).toBeLessThan(ids);
  expect(root.state.mirror["U-W"].persistence.savedGeneration).toBe(ids);
});

// A10 Hertz P1-5: a tick waiting for the retry deadline aggregated every unsaved input ID before finding nothing due.
it("P2-A10-T06 regression / AC12: a tick before retryAfter builds no input-ID correlation", async () => {
  const ids = 1_000;
  const files = nodeCheckpointFileSystem();
  const { root, now } = await unsavedRoot(ids, { ...files, async open() { throw new Error("injected open failure"); } });
  await root.driveCheckpoint(); // the write fails and sets a retry backoff
  expect(root.checkpoint.retryAfter("U-W")).toBeGreaterThan(now.monotonicMs);
  const add = vi.spyOn(Set.prototype, "add");
  try {
    await root.driveCheckpoint();
    expect(add.mock.calls.length).toBeLessThan(ids / 10); // 相関を作ると ids 回。期限前の tick は相関を作らない
  } finally { add.mockRestore(); }
  expect(root.state.mirror["U-W"].persistence.savedGeneration ?? 0).toBe(0);
});
