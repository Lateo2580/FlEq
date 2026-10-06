import { parentPort, workerData } from "node:worker_threads";

import type { OwnerRequest, OwnerStartData } from "../../contracts/p3-execution-split.types";
import { linkedUnitCodecs, linkedUnitTable, nodeCheckpointFileSystem, sharedClock } from "./composition-root";
import { OwnerHost } from "./owner-host";

// P3-C3A-AC01: the entry of one resident owner thread (dist/src/runtime/owner-worker.js). The host starts three,
// one per execution place; requests and replies cross by structured clone over the thread's port.
const port = parentPort;
if (port == null) throw new Error("owner-worker runs only as a worker thread");
const start: OwnerStartData = workerData;
const owner = new OwnerHost({
  start, units: linkedUnitTable, codecs: linkedUnitCodecs, fileSystem: nodeCheckpointFileSystem(),
  sharedNow: sharedClock,
  reply: (reply) => port.postMessage(reply),
  // A broken invariant ends the thread; the host reports it as ownerFailed (P3-C3B-OWNER-STOP).
  fail: (error) => { setImmediate(() => { throw error; }); },
});
// An exception here is uncaught in the thread and reaches the host as the worker's error event.
port.on("message", (request: OwnerRequest) => owner.handle(request));
