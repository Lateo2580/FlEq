"use strict";
// P3-C1-T05 child: saves g1, then g2, parking g2 at a boundary named in argv[3] so the parent can SIGKILL it.
// Uses the built product (reconstruction/dist) and its real nodeCheckpointFileSystem. Not a power-loss test.
const { join } = require("node:path");
const dist = join(__dirname, "..", "..", "dist", "src");
const { CheckpointCoordinator } = require(join(dist, "checkpoint", "checkpoint.js"));
const { nodeCheckpointFileSystem } = require(join(dist, "runtime", "composition-root.js"));

const [directory, stopAt] = process.argv.slice(2);
const real = nodeCheckpointFileSystem();
let armed = false;
const park = async (boundary) => {
  if (!armed || stopAt !== boundary) return;
  process.stdout.write(`boundary:${boundary}\n`);
  setInterval(() => {}, 1_000); // keep the process alive until the parent kills it
  await new Promise(() => {});
};
const fileSystem = { ...real,
  rename: async (from, to) => { await park("beforeRename"); return real.rename(from, to); },
  syncDirectory: async (path) => { await park("beforeSyncDirectory"); return real.syncDirectory(path); },
};
const codec = { schemaVersion: "p2-weather-timeseries-unit-v1", encode: (state) => state.value,
  decode: (payload) => ({ kind: "restored", state: { value: payload } }) };
const clock = () => ({ wallTimeMs: Date.now(), monotonicMs: performance.now() });
const coordinator = new CheckpointCoordinator(directory, { "U-F": codec }, fileSystem, clock, () => {});
coordinator.restoreUnit("U-F");

async function save(generation) {
  const state = { units: {
    "U-E": { persistence: null }, "U-W": { persistence: null },
    "U-F": { value: `g${generation}`, persistence: { kind: "pending", currentGeneration: generation,
      savedGeneration: generation > 1 ? generation - 1 : null, savedCapturedAt: null, savedAckAt: null, dirtySince: 0 } },
  }, checkpointAttempts: {} };
  const correlations = { "U-F": { inputIds: ["input"], retryReason: "notRetry" } };
  const scheduled = coordinator.scheduleCheckpoint(state, clock(), "stop", correlations);
  state.checkpointAttempts["U-F"] = scheduled.capture;
  const output = await coordinator.executeCheckpoint(scheduled.request, "stop", ["input"], "notRetry");
  coordinator.validateResult(state, output.result);
  coordinator.resultMetadata(state, output.result, clock());
  return output.result.kind;
}

(async () => {
  process.stdout.write(`g1:${await save(1)}\n`);
  armed = true;
  process.stdout.write(`g2:${await save(2)}\n`);
})();
