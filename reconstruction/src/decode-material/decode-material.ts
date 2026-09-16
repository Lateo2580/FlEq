import { Buffer } from "node:buffer";
import { gunzipSync, unzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type {
  DecodedMaterial,
  MaterialValue,
  Operation,
  OperationEvidence,
  OperationSourceEvidence,
  ParserDiagnostic,
  ParserMailboxItem,
  ParserMailboxResult,
  ProcessingMarks,
  XmlAttribute,
  XmlElement,
  XmlNode,
} from "../../contracts/p1-parser-boundary.types";
import { resolveOperation } from "../contracts-revision/operation";
import { recordParserDiagnostic } from "../diagnostics/parser-diagnostic";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 10 * 1024 * 1024;
const limits = { nodes: 320_000, depth: 24, attributes: 16, attributeValue: 256, text: 16_384 } as const;

type PreservedNode = Record<string, unknown>;
type MutableMarks = { ingressJsonMs: number | null; base64DecodeMs: number | null; decompressionMs: number | null; fullXmlParseMs: number | null; metadataSpecialValueMs: number | null; domainExtractionMs: number | null; workerTransferMs: number | null };

function marks(): MutableMarks {
  return { ingressJsonMs: null, base64DecodeMs: null, decompressionMs: null, fullXmlParseMs: null, metadataSpecialValueMs: null, domainExtractionMs: null, workerTransferMs: null };
}

function now(): number {
  return performance.now();
}

function finiteDuration(started: number): number {
  return Math.max(0, performance.now() - started);
}

function undetermined(item: ParserMailboxItem): ParserDiagnostic["operation"] {
  return { kind: "undetermined", sources: { headTest: item.headTest, envelopeStatus: item.envelopeStatus } };
}

function rejected(item: ParserMailboxItem, reason: string, expandedByteLength: number | null, operation = undetermined(item)): ParserMailboxResult {
  const diagnostic = { inputId: item.inputId, reason, operation, encodedByteLength: item.encodedByteLength, expandedByteLength };
  recordParserDiagnostic(diagnostic);
  return { kind: "rejected", diagnostic };
}

function strictBase64(value: Uint8Array): Uint8Array | null {
  const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8").replace(/[\r\n\t ]/g, "");
  if (text.length === 0 || text.length % 4 !== 0) return null;
  const decoded = Buffer.from(text, "base64");
  return decoded.toString("base64") === text ? decoded : null;
}

function bodyBytes(item: ParserMailboxItem, current: MutableMarks): Uint8Array | null {
  if (item.encoding === "utf-8") return item.encodedBody;
  const started = now();
  const decoded = strictBase64(item.encodedBody);
  current.base64DecodeMs = finiteDuration(started);
  return decoded;
}

function expanded(input: Uint8Array, current: MutableMarks, compression: ParserMailboxItem["compression"]): Uint8Array {
  const started = now();
  const output = compression === "gzip"
    ? gunzipSync(input, { maxOutputLength: MAX_EXPANDED_BYTES })
    : compression === "zip"
      ? unzipSync(input, { maxOutputLength: MAX_EXPANDED_BYTES })
      : input;
  current.decompressionMs = input === output ? null : finiteDuration(started);
  return output;
}

// Shared by the bounded scan and tree conversion so limits count the same semantic characters.
function xmlValue(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);|&/g, (_match, reference: string | undefined) => {
    if (reference == null) throw new Error("xmlInvalid");
    if (reference[0] !== "#") return new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["apos", "'"], ["quot", '"']]).get(reference)!;
    const point = reference[1] === "x" ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    if (!(point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) throw new Error("xmlInvalid");
    return String.fromCodePoint(point);
  });
}

function withinXmlLimits(xml: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(xml)) throw new Error("xmlInvalid");
  let nodes = 0;
  const stack: number[] = [];
  let index = 0;
  const textLength = (text: string) => Array.from(xmlValue(text)).length;
  const addText = (text: string, cdata = false) => {
    if (stack.length === 0) return;
    stack[stack.length - 1] += cdata ? Array.from(text).length : textLength(text);
    if (stack[stack.length - 1] > limits.text) throw new Error("xmlLimitExceeded");
  };
  while (index < xml.length) {
    if (xml[index] !== "<") {
      const end = xml.indexOf("<", index);
      addText(xml.slice(index, end < 0 ? xml.length : end));
      index = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith("<!--", index) || xml.startsWith("<?", index) || xml.startsWith("<![CDATA[", index)) {
      const cdata = xml.startsWith("<![CDATA[", index);
      const ending = cdata ? "]]>" : xml.startsWith("<!--", index) ? "-->" : "?>";
      const start = index + (cdata ? 9 : ending === "-->" ? 4 : 2);
      const end = xml.indexOf(ending, start);
      if (end < 0) throw new Error("xmlInvalid");
      if (cdata) addText(xml.slice(start, end), true);
      index = end + ending.length;
      continue;
    }
    if (xml.startsWith("<!", index)) throw new Error("xmlInvalid"); // No DTD/entity expansion.
    let end = index + 1;
    let quote = "";
    let attributeStart = 0;
    let attributeCount = 0;
    for (; end < xml.length; end += 1) {
      const ch = xml[end];
      if (quote !== "") {
        if (ch === quote) {
          if (textLength(xml.slice(attributeStart, end)) > limits.attributeValue) throw new Error("xmlLimitExceeded");
          quote = "";
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        attributeStart = end + 1;
        if (++attributeCount > limits.attributes) throw new Error("xmlLimitExceeded");
      } else if (ch === ">") break;
    }
    if (end === xml.length) throw new Error("xmlInvalid");
    if (xml[index + 1] === "/") stack.pop();
    else {
      if (++nodes > limits.nodes || stack.length + 1 > limits.depth) throw new Error("xmlLimitExceeded");
      if (xml[end - 1] !== "/") stack.push(0);
    }
    index = end + 1;
  }
  return true;
}
function attributes(value: unknown): readonly XmlAttribute[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([name, attribute]) => ({ name, value: xmlValue(String(attribute)) }));
}

function xmlNode(value: PreservedNode): XmlNode | null {
  if (Array.isArray(value["#cdata"])) return { kind: "text", value: (value["#cdata"] as PreservedNode[]).map(node => String(node["#text"] ?? "")).join("") };
  const entry = Object.entries(value).find(([name]) => name !== ":@" && name !== "#text");
  if (entry == null) return typeof value["#text"] === "string" ? { kind: "text", value: xmlValue(value["#text"]) } : null;
  const [name, nested] = entry;
  if (!Array.isArray(nested)) return null;
  const children = nested.flatMap((child) => {
    if (child == null || typeof child !== "object" || Array.isArray(child)) return [];
    const result = xmlNode(child as PreservedNode);
    return result == null ? [] : [result];
  });
  return { kind: "element", name, attributes: attributes(value[":@"]), children };
}

function parseTree(xml: string): XmlElement | null {
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "#text", cdataPropName: "#cdata", processEntities: false, trimValues: false, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  const source = Array.isArray(parsed) ? parsed.find((node) => node != null && typeof node === "object" && "Report" in node) : null;
  if (source == null) return null;
  const root = xmlNode(source as PreservedNode);
  return root != null && root.kind === "element" ? root : null;
}

function child(element: XmlElement, name: string): XmlElement | null {
  return element.children.find((node): node is XmlElement => node.kind === "element" && node.name === name) ?? null;
}

function directText(element: XmlElement | null): string | null {
  if (element == null) return null;
  return element.children.filter((node): node is Extract<XmlNode, { kind: "text" }> => node.kind === "text").map((node) => node.value).join("");
}

function childText(element: XmlElement | null, name: string): string | null {
  return directText(element == null ? null : child(element, name));
}

function normalizeStatus(raw: string | null): OperationSourceEvidence<Operation> {
  if (raw == null || raw === "") return { kind: "missing" };
  const status = new Map<string, Operation>([["通常", "normal"], ["訓練", "training"], ["試験", "test"], ["normal", "normal"], ["training", "training"], ["test", "test"]]).get(raw);
  return status == null ? { kind: "invalid", observed: raw } : { kind: "provided", value: status };
}

function materialValue(raw: string | undefined, condition = ""): MaterialValue {
  if (raw === undefined) return { kind: "missing" };
  const normalized = raw.normalize("NFKC").trim();
  const match = (condition.normalize("NFKC") || normalized).match(/([+-]?(?:\d+(?:\.\d+)?|\.\d+)).*(以上|超|未満|以下)/);
  if (match != null) return { kind: "range", bound: match[2] === "以上" || match[2] === "超" ? "lower" : "upper", value: Number(match[1]), raw };
  if (/不明|未定|NaN|なし/.test(condition || normalized)) return { kind: "unknown", raw };
  if (normalized === "") return { kind: "empty", raw };
  const number = Number(normalized);
  if (Number.isFinite(number)) return { kind: "number", value: number, raw };
  return { kind: "text", value: raw, raw };
}

function familyFor(headType: string): string {
  if (headType === "VXSE43") return "eew.warning";
  if (headType === "VXSE44" || headType === "VXSE45") return "eew.forecast";
  if (/^(VF|VZVO)/.test(headType)) return "telegram.volcano";
  if (/^(VTSE|VXSE|VYSE|VZSE)/.test(headType)) return "telegram.earthquake";
  return "telegram.weather";
}

/** Returns the route/family boundary and lossless leaf material values for P1 consumers. */
export function classifyMaterial(material: DecodedMaterial) {
  const started = now();
  const values: MaterialValue[] = [];
  const fields: { path: string; value: MaterialValue }[] = [];
  const visit = (node: XmlElement, path: string): void => {
    const nested = node.children.filter((c): c is XmlElement => c.kind === "element");
    if (nested.length === 0) {
      const value = materialValue(directText(node) ?? "", node.attributes.find((a) => a.name === "condition")?.value);
      values.push(value);
      fields.push({ path, value });
    }
    nested.forEach((c, i) => visit(c, `${path}/${c.name}[${i}]`));
  };
  visit(material.xml, "/Report");
  const head = child(material.xml, "Head");
  const metadata = { eventId: materialValue(childText(head, "EventID") ?? undefined), serial: materialValue(childText(head, "Serial") ?? undefined) };
  const metadataSpecialValueMs = (material.marks.metadataSpecialValueMs ?? 0) + finiteDuration(started);
  const domainAt = now();
  const route = familyFor(material.headType);
  const domainExtractionMs = finiteDuration(domainAt);
  return {
    route,
    family: material.headType,
    materialValues: values,
    fields,
    metadata,
    marks: { ...material.marks, metadataSpecialValueMs, domainExtractionMs },
  } as const;
}

/** Decodes, bounds, full-parses and resolves one mailbox item without retaining its raw body. */
export function decodeMaterial(item: ParserMailboxItem): ParserMailboxResult {
  if (item.encodedByteLength > MAX_INPUT_BYTES || item.encodedBody.byteLength > MAX_INPUT_BYTES) return rejected(item, "inputTooLarge", null);
  const current = marks();
  let encoded: Uint8Array | null;
  try { encoded = bodyBytes(item, current); } catch { return rejected(item, "bodyDecodeFailed", null); }
  if (encoded == null) return rejected(item, "bodyDecodeFailed", null);
  let raw: Uint8Array;
  try { raw = expanded(encoded, current, item.compression); } catch (error) {
    const tooLarge = error != null && typeof error === "object" && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE";
    return rejected(item, tooLarge ? "expandedBodyTooLarge" : "expandedBodyInvalid", null);
  }
  if (raw.byteLength > MAX_EXPANDED_BYTES) return rejected(item, "expandedBodyTooLarge", raw.byteLength);
  let xmlText: string;
  try {
    // TextDecoder strips a leading UTF-8 BOM (ignoreBOM:false); byte accounting still includes it.
    xmlText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
    withinXmlLimits(xmlText);
    if (XMLValidator.validate(xmlText) !== true) return rejected(item, "xmlInvalid", raw.byteLength);
  } catch (error) { return rejected(item, error instanceof Error && error.message === "xmlLimitExceeded" ? "xmlLimitExceeded" : "xmlInvalid", raw.byteLength); }
  const parsedAt = now();
  let xml: XmlElement | null;
  try { xml = parseTree(xmlText); } catch { return rejected(item, "xmlInvalid", raw.byteLength); }
  current.fullXmlParseMs = finiteDuration(parsedAt);
  if (xml == null || xml.name !== "Report") return rejected(item, "xmlInvalid", raw.byteLength);
  const metadataAt = now();
  const controlStatus = normalizeStatus(childText(child(xml, "Control"), "Status"));
  const evidence: OperationEvidence = { headTest: item.headTest, envelopeStatus: item.envelopeStatus, controlStatus };
  const operation = resolveOperation(evidence);
  if (operation.kind === "rejected") return rejected(item, operation.reason, raw.byteLength, operation);
  const head = child(xml, "Head");
  const draft: DecodedMaterial = {
    inputId: item.inputId,
    origin: item.origin,
    operation: operation.operation,
    headType: item.headType,
    reportDateTimeRaw: childText(head, "ReportDateTime") ?? "",
    eventIdRaw: childText(head, "EventID") ?? "",
    serialRaw: childText(head, "Serial") ?? "",
    infoTypeRaw: childText(head, "InfoType") ?? "",
    xml,
    decodedByteLength: encoded.byteLength,
    expandedByteLength: raw.byteLength,
    marks: current,
  };
  current.metadataSpecialValueMs = finiteDuration(metadataAt);
  const material: DecodedMaterial = draft;
  return { kind: "decoded", material };
}

export const parserLimits = { inputBytes: MAX_INPUT_BYTES, expandedBytes: MAX_EXPANDED_BYTES, ...limits } as const;
