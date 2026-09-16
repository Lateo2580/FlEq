import { Buffer } from "node:buffer";
import type { AcquisitionOrigin, Operation, OperationEvidence, ParserDiagnostic, ParserMailboxItem } from "../../contracts/p1-parser-boundary.types";
import { recordParserDiagnostic } from "../diagnostics/parser-diagnostic";

type IngressInput = Readonly<{
  inputId: string; inputSequence: number; receivedAt: number; origin: AcquisitionOrigin;
}> & (Readonly<{ kind: "ws"; frame: Uint8Array }> | Readonly<{ kind: "rest" | "replay"; body: Uint8Array; headType: string }>);

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Checks transport bytes before JSON parsing or body allocation. */
export function ingestXmlData(input: IngressInput):
  | Readonly<{ kind: "accepted"; item: ParserMailboxItem; ingressJsonMs: number | null }>
  | Readonly<{ kind: "rejected"; diagnostic: ParserDiagnostic }> {
  const bytes = input.kind === "ws" ? input.frame : input.body;
  const sources: { -readonly [K in keyof OperationEvidence]?: OperationEvidence[K] } = {};
  const reject = (reason: string) => {
    const diagnostic: ParserDiagnostic = { inputId: input.inputId, reason, operation: { kind: "undetermined", sources }, encodedByteLength: bytes.byteLength, expandedByteLength: null };
    recordParserDiagnostic(diagnostic);
    return { kind: "rejected" as const, diagnostic };
  };
  if (bytes.byteLength > 8 * 1024 * 1024) return reject("inputTooLarge");
  let headType: string;
  let encodedBody: Uint8Array;
  let encoding: ParserMailboxItem["encoding"] = "utf-8";
  let compression: ParserMailboxItem["compression"] = null;
  let ingressJsonMs: number | null = null;
  if (input.kind === "ws") {
    let message: Record<string, unknown>;
    const start = performance.now();
    try { message = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { return reject("envelopeInvalid"); }
    ingressJsonMs = performance.now() - start;
    const head = object(message.head);
    const status = object(object(message.xmlReport).control).status;
    const observed = (v: unknown): string | boolean | null => typeof v === "boolean" ? v : typeof v === "string" ? v.slice(0, 256) : null;
    sources.headTest = head.test === undefined ? { kind: "missing" } : typeof head.test === "boolean" ? { kind: "provided", value: head.test } : { kind: "invalid", observed: observed(head.test) };
    const statuses = new Map<string, Operation>([["通常", "normal"], ["訓練", "training"], ["試験", "test"], ["normal", "normal"], ["training", "training"], ["test", "test"]]);
    const normalized = typeof status === "string" ? statuses.get(status) : undefined;
    sources.envelopeStatus = status === undefined
      ? (message.format === "xml" || message.format === "json" ? { kind: "missing" } : { kind: "notProvided" })
      : normalized == null ? { kind: "invalid", observed: observed(status) } : { kind: "provided", value: normalized };
    if (message.format !== "xml") return reject("formatUnsupported");
    if (message.type !== "data" || typeof head.type !== "string" || typeof message.body !== "string") return reject("envelopeInvalid");
    if (message.encoding !== "base64" && message.encoding !== "utf-8") return reject("encodingUnsupported");
    if (message.compression !== null && message.compression !== "gzip" && message.compression !== "zip") return reject("compressionUnsupported");
    encoding = message.encoding;
    compression = message.compression;
    encodedBody = Buffer.from(message.body, "utf8");
    headType = head.type;
  } else {
    sources.headTest = { kind: "notProvided" };
    sources.envelopeStatus = { kind: "notProvided" };
    encodedBody = bytes;
    headType = input.headType;
  }
  const item: ParserMailboxItem = { inputId: input.inputId, inputSequence: input.inputSequence, receivedAt: input.receivedAt, origin: input.origin, headType, encoding, compression, encodedBody, encodedByteLength: encodedBody.byteLength, headTest: sources.headTest, envelopeStatus: sources.envelopeStatus };
  return { kind: "accepted", item, ingressJsonMs };
}
