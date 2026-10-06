// P3-C3B-T02 test-only owner entry: blocks the owner's own thread on demand, then runs the product owner entry
// unchanged. The test's node:worker_threads mock starts the deferred owner here (the product has no injection point).
const { parentPort, workerData } = require("node:worker_threads");

const flag = new Int32Array(workerData.c3bBlock);
const entry = workerData.c3bEntry;
// Gone before the owner entry reads workerData, which is then the product's OwnerStartData.
delete workerData.c3bBlock;
delete workerData.c3bEntry;
// Added before the owner's listener, so it runs first on every request: while the flag is 1 the thread really waits.
parentPort.on("message", () => { while (Atomics.load(flag, 0) === 1) Atomics.wait(flag, 0, 1); });
require(entry);
