// P2-A7-E21-LOAD-v1/R32: charge queue and lower-priority stop time, but exclude
// only the overlap with an already running same-group predecessor on this channel.
function judgeLatency(generated, spawned, predecessorSpawned = null, predecessorClosed = null, hasPredecessor = false) {
  const observed = generated != null && spawned != null
    && (!hasPredecessor || predecessorSpawned != null && predecessorClosed != null);
  const durationMs = generated == null || spawned == null ? null : spawned - generated;
  const excludedPredecessorWaitMs = !observed ? null : !hasPredecessor ? 0
    : Math.max(0, Math.min(spawned, predecessorClosed) - Math.max(generated, predecessorSpawned));
  const adjustedDurationMs = durationMs == null || excludedPredecessorWaitMs == null
    ? null : durationMs - excludedPredecessorWaitMs;
  const closeToSpawnMs = spawned == null || predecessorClosed == null ? null : spawned - predecessorClosed;
  const status = !observed ? "blocked" : adjustedDurationMs >= 0 && adjustedDurationMs <= 1_000
    && (!hasPredecessor || closeToSpawnMs >= 0 && closeToSpawnMs <= 100) ? "pass" : "fail";
  return { durationMs, excludedPredecessorWaitMs, adjustedDurationMs, closeToSpawnMs, status };
}

module.exports = { judgeLatency };
