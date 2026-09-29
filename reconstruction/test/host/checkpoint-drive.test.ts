import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { NotificationDeliveryState } from "../../contracts/p2-notification-delivery.types";
import { RuntimeCompositionRoot, linkedRuntimeCalls, linkedUnitCodecs, nodeCheckpointFileSystem } from "../../src/runtime/composition-root";
import { recordingNotificationAdapter, testNotificationChannels } from "../checkpoint-shutdown/runtime-fixture";
import { atTime, decode, received } from "../snapshot-sse/projection-fixture";

const runtimeCalls = { ...linkedRuntimeCalls, selectNotificationAttempt: (delivery: NotificationDeliveryState) =>
  ({ state: delivery, attempts: [], abortRequests: [], diagnostics: [] }) };
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await fileSystem.rm(path, { recursive: true, force: true }); });

// P2-A10-AC12 (save driving): without a repeated reconciliation the unit stays uncertain and is never saved again.
it("P2-A10-T06 / AC12: driveCheckpoint reconciles an uncertain unit on each due tick until it is saved, then saves the next generation", async () => {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-a10-drive-"));
  directories.push(path);
  const files = nodeCheckpointFileSystem();
  const sync = { calls: 0, fail: true };
  // The write's directory sync and the first reconciliation fail; the test then lets the due reconciliation succeed.
  const checkpointFileSystem = { ...files, async syncDirectory(directory: string) {
    sync.calls += 1;
    if (sync.fail) throw new Error("injected directory sync failure");
    return files.syncDirectory(directory);
  } };
  const now = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
  const clock = () => ({ ...now });
  const root = new RuntimeCompositionRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") }, linkedUnitCodecs,
  { runtimeCalls, notificationAdapter: recordingNotificationAdapter(), clock, checkpointFileSystem });
  root.startRuntime("run", clock(), testNotificationChannels);
  root.dispatch(root.state, { kind: "notificationProbeCompleted", channels: testNotificationChannels, clock: clock() });
  root.dispatch(root.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57"), clock()));
  const persistence = () => root.state.units["U-W"].persistence;

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

  root.dispatch(root.state, received("run", decode("15_16_02_251222_VPWW57", "VPWW57",
    (xml) => atTime(xml, "2020-06-22T23:01:00+09:00"), "follow-up"), clock()));
  await root.driveCheckpoint();
  expect(persistence()).toMatchObject({ kind: "saved", savedGeneration: 2 });
});
