import type { DecodedMaterial } from "../../contracts/p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  DiagnosticEvent,
  ParserDiagnosticReason,
  RejectionReason,
  RuntimeInput,
  RuntimeState,
  RuntimeStep,
  SemanticEnvelopeResult,
  UnitId,
} from "../../contracts/p2-shared-runtime.types";
import { boundDiagnosticDetails, completeDiagnostic } from "./runtime-diagnostic";

const EMPTY: readonly never[] = Object.freeze([]);
const parserReasons = [
  "operationMissing", "operationInvalid", "operationMismatch", "operationAmbiguous",
  "formatUnsupported", "inputTooLarge", "envelopeInvalid", "encodingUnsupported",
  "compressionUnsupported", "bodyDecodeFailed", "expandedBodyInvalid",
  "expandedBodyTooLarge", "xmlLimitExceeded", "xmlInvalid",
] satisfies readonly ParserDiagnosticReason[];

function rejection(material: DecodedMaterial, reason: RejectionReason): SemanticEnvelopeResult {
  return {
    kind: "rejected",
    reason,
    diagnostic: boundDiagnosticDetails({ level: "WARN", component: "shared-runtime", reason, inputId: material.inputId }),
  };
}

function reportDateTime(raw: string): number | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (match == null) return null;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  const offsetMinutes = match[7] === "Z" ? 0 : (match[8] === "+" ? 1 : -1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = new Date(value + offsetMinutes * 60_000);
  const actual = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  return actual.every((part, index) => part === Number(match[index + 1])) ? value : null;
}

function validateSemanticEnvelope(material: DecodedMaterial): SemanticEnvelopeResult {
  if (!material.xml.children.some((node) => node.kind === "element" && node.name === "Head")) {
    return rejection(material, "headMissing");
  }
  if (material.reportDateTimeRaw.trim() === "") return rejection(material, "reportDateTimeMissing");
  const reportDateTimeMs = reportDateTime(material.reportDateTimeRaw);
  if (reportDateTimeMs == null) return rejection(material, "reportDateTimeInvalid");
  return { kind: "accepted", envelope: { material, reportDateTimeMs } };
}

function parserDiagnostic(reason: string, inputId: string): DiagnosticDetails | null {
  const matched = parserReasons.find((candidate) => candidate === reason);
  if (matched == null) return null;
  return boundDiagnosticDetails({ level: "WARN", component: "parser", reason: matched, inputId });
}

function reduceRuntime<UnitStates extends Readonly<Partial<Record<UnitId, unknown>>>>(
  state: RuntimeState<UnitStates>,
  input: RuntimeInput,
): RuntimeStep<UnitStates> {
  let diagnostics: readonly DiagnosticEvent[] = EMPTY;
  if (input.kind === "mailboxCompleted" && input.completion.kind === "parser") {
    const { completion } = input;
    const details = completion.result.kind === "rejected"
      ? parserDiagnostic(completion.result.diagnostic.reason, completion.result.diagnostic.inputId)
      : (() => {
          const result = validateSemanticEnvelope(completion.result.material);
          return result.kind === "rejected" ? result.diagnostic : null;
        })();
    if (details != null) diagnostics = [completeDiagnostic(details, input.clock, completion.runId)];
  }
  return {
    state,
    changedUnits: EMPTY,
    checkpointRequests: EMPTY,
    notificationIntents: EMPTY,
    outcomes: EMPTY,
    views: EMPTY,
    diagnostics,
  };
}

export { reduceRuntime, validateSemanticEnvelope };
