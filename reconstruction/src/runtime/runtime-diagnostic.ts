import type { ClockReading, DiagnosticDetails, DiagnosticEvent } from "../../contracts/p2-shared-runtime.types";

const encoder = new TextEncoder();

// Four free-text fields at 1536 JSON bytes each leave room within 8192 bytes
// for fixed keys, enums, finite numbers, punctuation and the sink newline.
function boundedString(value: string): string {
  const marker = "[truncated:fieldLimit]";
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(JSON.stringify(character)).byteLength - 2;
    if (bytes + size > 1536 - marker.length) return prefix + marker;
    prefix += character;
    bytes += size;
  }
  return value;
}

function boundDiagnosticDetails(details: DiagnosticDetails): DiagnosticDetails {
  return {
    level: details.level,
    component: boundedString(details.component),
    reason: details.reason,
    ...(details.inputId == null ? {} : { inputId: boundedString(details.inputId) }),
    ...(details.unit == null ? {} : { unit: details.unit }),
    ...(details.generation == null || !Number.isFinite(details.generation) ? {} : { generation: details.generation }),
    ...(details.attemptId == null ? {} : { attemptId: boundedString(details.attemptId) }),
    ...(details.durationMs == null || !Number.isFinite(details.durationMs) ? {} : { durationMs: details.durationMs }),
    ...(details.count == null || !Number.isFinite(details.count) ? {} : { count: details.count }),
  };
}

function completeDiagnostic(details: DiagnosticDetails, clock: ClockReading, runId: string): DiagnosticEvent {
  // Only the explicit allowlisted projection is spread, never the caller's object.
  return { timestamp: clock.wallTimeMs, ...boundDiagnosticDetails(details), runId: boundedString(runId) };
}

export { boundedString, boundDiagnosticDetails, completeDiagnostic };
