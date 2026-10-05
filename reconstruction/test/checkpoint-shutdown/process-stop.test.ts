import { spawn } from "node:child_process";
import { existsSync, promises as disk, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { harnessedRoot, startHarness } from "../execution-split/owner-harness";
import { fixtureDriver, fixtureState, recordingNotificationAdapter, stringCodec } from "./runtime-fixture";

const temporary: string[] = [];
const inputIds = { "U-F": ["input-3"] };
const clock = { wallTimeMs: 9_000, monotonicMs: 900 };

afterEach(async () => {
  for (const path of temporary.splice(0)) await disk.rm(path, { recursive: true, force: true });
});

// Runs the built product in a child, waits for it to park g2 at `boundary`, then SIGKILLs it (always, even on failure).
async function killAtBoundary(stateDirectory: string, boundary: "beforeRename" | "beforeSyncDirectory"): Promise<string> {
  const child = spawn(process.execPath, [join(__dirname, "process-stop-child.cjs"), stateDirectory, boundary],
    { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never reached ${boundary}: ${output}`)), 20_000);
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`child exited early: ${output}`)); });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`boundary:${boundary}`)) { clearTimeout(timer); resolve(); }
      });
    });
  } finally {
    const exited = new Promise<void>((resolve) => child.exitCode != null || child.signalCode != null
      ? resolve() : child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  return output;
}

const generationOf = (path: string): number => (JSON.parse(readFileSync(path, "utf8")) as { generation: number }).generation;

describe("P3-C1-T05 process-stop test (SIGKILL; the OS cache survives, so this is NOT evidence of power-loss durability)", () => {
  for (const [boundary, restoredGeneration, restoredSlot] of [
    ["beforeRename", 1, "A"], ["beforeSyncDirectory", 2, "B"],
  ] as const) {
    it(`P3-C1-T05 acceptance / AC05: SIGKILL ${boundary} keeps g${restoredGeneration}; the next save writes the other slot`, async () => {
      const path = await disk.mkdtemp(join(tmpdir(), "fleq-c1-stop-"));
      temporary.push(path);
      const stateDirectory = join(path, "state");
      const output = await killAtBoundary(stateDirectory, boundary);
      expect(output).toContain("g1:acknowledged");
      expect(existsSync(join(stateDirectory, "U-F.json.tmp"))).toBe(boundary === "beforeRename");

      // TEST-PATH (2): the restarted runtime; its owner reclaims the orphan tmp as it restores at startup.
      const driver = fixtureDriver();
      const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory,
        legacyStateDirectory: join(path, "legacy"), diagnosticDirectory: join(path, "diagnostics") },
      { "U-F": stringCodec("U-F") }, { notificationAdapter: recordingNotificationAdapter(), runtimeCalls: driver.calls,
        clock: () => clock });
      await startHarness(h, "stop", clock);
      expect(existsSync(join(stateDirectory, "U-F.json.tmp"))).toBe(false);
      const restore = () => h.owners.get("deferred")!["checkpoint"].restoreUnit("U-F");
      expect(restore()).toMatchObject({ kind: "restored", slot: restoredSlot, envelope: { generation: restoredGeneration } });

      const state = fixtureState({ "U-F": "g3" }, { "U-F": { kind: "pending", currentGeneration: 3,
        savedGeneration: restoredGeneration, savedCapturedAt: 1, savedAckAt: 2, dirtySince: 1 } }, "stop");
      await driver.update(h, state, clock, inputIds);
      const released = h.root.driveCheckpoint();
      await h.settle();
      await released;
      expect(h.delivered.flatMap(({ reply }) => reply.kind === "checkpointDone" ? [reply.result?.kind] : [])).toEqual(["acknowledged"]);
      const otherSlot = restoredSlot === "A" ? "B" : "A";
      expect(generationOf(join(stateDirectory, `U-F-${restoredSlot}.json`))).toBe(restoredGeneration);
      expect(generationOf(join(stateDirectory, `U-F-${otherSlot}.json`))).toBe(3);
      expect(restore()).toMatchObject({ kind: "restored", slot: otherSlot, envelope: { generation: 3 } });
      await h.root.diagnostics.flush();
    });
  }
});
