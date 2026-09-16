import type {
  Operation,
  OperationEvidence,
  OperationResolution,
  OperationSourceEvidence,
} from "../../contracts/p1-parser-boundary.types";

function candidates(source: OperationSourceEvidence<boolean | Operation>): readonly Operation[] {
  if (source.kind !== "provided") return [];
  if (source.value === true) return ["training", "test"];
  if (source.value === false) return ["normal"];
  return [source.value];
}

/** Resolves only evidence actually supplied by the transport and document. */
export function resolveOperation(evidence: OperationEvidence): OperationResolution {
  const sources = [evidence.headTest, evidence.controlStatus, evidence.envelopeStatus];
  if (sources.some((source) => source.kind === "missing")) {
    return { kind: "rejected", reason: "operationMissing", sources: evidence };
  }
  if (sources.some((source) => source.kind === "invalid")) {
    return { kind: "rejected", reason: "operationInvalid", sources: evidence };
  }

  const provided = sources.filter(
    (source): source is Extract<OperationSourceEvidence<boolean | Operation>, { kind: "provided" }> =>
      source.kind === "provided",
  );
  if (evidence.controlStatus.kind === "notProvided" && evidence.envelopeStatus.kind === "notProvided") {
    return { kind: "rejected", reason: "operationAmbiguous", sources: evidence };
  }

  const possible = (["normal", "training", "test"] as const).filter((operation) =>
    provided.every((source) => candidates(source).includes(operation)),
  );
  if (possible.length === 0) {
    return { kind: "rejected", reason: "operationMismatch", sources: evidence };
  }
  if (possible.length !== 1) {
    return { kind: "rejected", reason: "operationAmbiguous", sources: evidence };
  }
  return { kind: "resolved", operation: possible[0], sources: evidence };
}
