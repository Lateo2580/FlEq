import type { ClockReading, DiagnosticDetails, DiagnosticEvent, ParserDiagnosticReason } from "../../contracts/p2-shared-runtime.types";

const encoder = new TextEncoder();
const parserDiagnosticReasons = [
  "operationMissing", "operationInvalid", "operationMismatch", "operationAmbiguous",
  "formatUnsupported", "inputTooLarge", "envelopeInvalid", "encodingUnsupported",
  "compressionUnsupported", "bodyDecodeFailed", "expandedBodyInvalid",
  "expandedBodyTooLarge", "xmlLimitExceeded", "xmlInvalid",
] satisfies readonly ParserDiagnosticReason[];

// Four free-text fields at 1536 JSON bytes each leave room within 8192 bytes
// for fixed keys, enums, finite numbers, punctuation and the sink newline.
// limit は引用符を除いた JSON の byte（P3-UM-AC11 (3)(12): H43 のカードの欄は同じ切り方で上限だけ違う）。
function boundedString(value: string, limit = 1536): string {
  const marker = "[truncated:fieldLimit]";
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(JSON.stringify(character)).byteLength - 2;
    if (bytes + size > limit - marker.length) return prefix + marker;
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

export { parserDiagnosticReasons, boundedString, boundDiagnosticDetails, completeDiagnostic };
