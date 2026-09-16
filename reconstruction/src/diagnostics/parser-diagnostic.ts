import { Buffer } from "node:buffer";
import type { ParserDiagnostic, OperationSourceEvidence } from "../../contracts/p1-parser-boundary.types";

const diagnostics: string[] = [];
let diagnosticBytes = 0;

function lineFor(diagnostic: ParserDiagnostic): string {
  let truncated = false;
  const bounded = (value: string, length: number) => {
    if (value.length > length) truncated = true;
    return value.slice(0, length);
  };
  const source = (value: OperationSourceEvidence<unknown>) => {
    if (value.kind === "provided") return { kind: value.kind, value: value.value };
    if (value.kind !== "invalid") return { kind: value.kind };
    const observed = value.observed;
    return { kind: "invalid", observed: typeof observed === "string"
      ? (/[<>&]|bearer|token|authorization/i.test(observed) ? "[redacted]" : bounded(observed, 128))
      : observed };
  };
  const sources = Object.fromEntries(
    (["headTest", "controlStatus", "envelopeStatus"] as const).flatMap((key) => {
      const evidence = diagnostic.operation.sources[key];
      return evidence == null ? [] : [[key, source(evidence)]];
    }),
  );
  const operation = diagnostic.operation.kind === "undetermined"
    ? { kind: "undetermined", sources }
    : diagnostic.operation.kind === "resolved"
      ? { kind: "resolved", operation: diagnostic.operation.operation, sources }
      : { kind: "rejected", reason: bounded(diagnostic.operation.reason, 128), sources };
  const event = {
    timestamp: new Date().toISOString(), level: "WARN", component: "parser",
    reason: bounded(diagnostic.reason, 128), runId: "p1", inputId: bounded(diagnostic.inputId, 256),
    operation, encodedByteLength: diagnostic.encodedByteLength, expandedByteLength: diagnostic.expandedByteLength,
  };
  // Fixed field projection and caps bound even JSON's six-byte character escaping below 8192 bytes.
  return JSON.stringify({ ...event, ...(truncated ? { truncationReason: "fieldLimit" } : {}) });
}

/** Only bounded projections enter this finite ring; no raw body or exception object is stored. */
export function recordParserDiagnostic(diagnostic: ParserDiagnostic): void {
  const line = lineFor(diagnostic);
  const bytes = Buffer.byteLength(line);
  while (diagnostics.length >= 256 || diagnosticBytes + bytes > 1048576) {
    const removed = diagnostics.shift();
    if (removed == null) break;
    diagnosticBytes -= Buffer.byteLength(removed);
  }
  diagnostics.push(line);
  diagnosticBytes += bytes;
}
