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

const ENTITIES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["apos", "'"], ["quot", '"']]);

// Shared by the bounded scan and tree conversion so limits count the same semantic characters.
// & の無い text が大半なので、置換の正規表現を走らせずにそのまま返す（P3-WL1-AC02）。
function xmlValue(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|apos|quot);|&/g, (_match, reference: string | undefined) => {
    if (reference == null) throw new Error("xmlInvalid");
    if (reference[0] !== "#") return ENTITIES.get(reference)!;
    const point = reference[1] === "x" ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    if (!(point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) throw new Error("xmlInvalid");
    return String.fromCodePoint(point);
  });
}

// Array.from(text).length と同じ数（サロゲートペアは 1、孤立サロゲートも 1）を、配列を作らずに数える（P3-WL1-AC02）。
function codePointLength(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { count--; index++; }
    }
  }
  return count;
}

function withinXmlLimits(xml: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(xml)) throw new Error("xmlInvalid");
  let nodes = 0;
  const stack: number[] = [];
  let index = 0;
  const textLength = (text: string) => codePointLength(xmlValue(text));
  const addText = (text: string, cdata = false) => {
    if (stack.length === 0) return;
    stack[stack.length - 1] += cdata ? codePointLength(text) : textLength(text);
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

// 旧の経路。速い経路が変な形を見つけたときだけ通る（P3-WL2-AC01、作者裁定 2026-10-09 の 2 本目）。
function parseTree(xml: string): XmlElement | null {
  // jPath:false は callback へ渡す path を文字列にしないだけで、木は同じ（P3-WL1-AC01）。path を読む callback を足すときは見直す。
  const parsed = new XMLParser({ jPath: false, preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "#text", cdataPropName: "#cdata", processEntities: false, trimValues: false, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  const source = Array.isArray(parsed) ? parsed.find((node) => node != null && typeof node === "object" && "Report" in node) : null;
  if (source == null) return null;
  const root = xmlNode(source as PreservedNode);
  return root != null && root.kind === "element" ? root : null;
}

// 速い経路が扱うのは実電文に出る形だけ（要素・属性・text・コメント・実体参照・最上位の XML 宣言）。ほかの形は写さずに旧の経路へ戻す
// （作者裁定 2026-10-09 の 2 本目、統合担当の決定 Q-WL2-IMPL-AMEND）。
// D4・D6: critical 名 3 つ（旧は例外）と危険な名前 7 つ（旧は "__" を付けて改名し、改名先と衝突すると 1 つにまとめる）。FXP 5.5.8 の
// util.js の criticalProperties と DANGEROUS_PROPERTY_NAMES。D3: 旧の木で key として特別に扱われる名前（strictReservedNames の #text・#cdata を含む）。
const OLD_PATH_NAMES = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "#text", "#cdata", ":@"]);
// FXP 5.5.8 の attrsRegx と同じ（m は ^$ を使わないので落とした）。
const ATTRIBUTE = /([^\s=]+)\s*(=\s*(['"])([\s\S]*?)\3)?/g;
const WHITESPACE = /\s/;
// D5 の例外: 実電文の XML 宣言の形（<?xml と最初の ?> の間）。タブ・単引用符・ほかの擬似属性は旧の経路へ戻す。
const XML_DECLARATION = /^xml(?: +(?:version|encoding|standalone)="[^"]*")* *$/;

function fallback(): never {
  throw new Error("xmlTreeFallback");
}

function checkedName(name: string): string {
  if (OLD_PATH_NAMES.has(name)) fallback();
  return name;
}

// validator が通した属性の文字列は「空白・名前・=・引用符の値」の並びで、名前は XML の名前で重複しない。そのため FXP の
// buildAttributesMap（object の key）と同じ順と値を、表を作らずに配列で得られる。値は Report の部分木でだけ展開する（旧の xmlNode）。
function attributeList(source: string, expand: boolean): XmlAttribute[] {
  const list: XmlAttribute[] = [];
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(source); match != null; match = ATTRIBUTE.exec(source)) {
    const name = checkedName(match[1]);
    const value: string | undefined = match[4];
    if (expand && value !== undefined) list.push({ name, value: xmlValue(value) });
  }
  return list;
}

// FXP の tagExpWithClosingIndex と同じく、引用符の中を飛ばして > を探す。
function quotedEnd(xml: string, from: number): number {
  let quote = 0;
  for (let index = from; index < xml.length; index++) {
    const code = xml.charCodeAt(index);
    if (quote !== 0) { if (code === quote) quote = 0; }
    else if (code === 34 || code === 39) quote = code;
    else if (code === 62) return index;
  }
  return -1;
}

// 速い経路（P3-WL2-AC01、D-WL2-DEP=B）: FXP 5.5.8 の OrderedObjParser.parseXml（parseTree の options）と xmlNode を合わせた結果を、
// 中間の木を作らずに XmlNode で直接返す。limits と XMLValidator を通った文字列だけを受ける前提で、検出の規則（D2〜D6）に当たったら
// fallback() で投げ、呼び手がその入力を旧の経路で処理し直す。旧が例外にする条件では必ず投げる（理由は写さない。拒否と理由は旧の経路が
// 決める）。普通の入力で投げても遅くなるだけで結果は旧と同じ。
function fastTree(input: string): XmlElement | null {
  // 旧の FXP と同じく組立ての段の中で改行を正規化する。\r の無い文書は写しを作らない（P3-WL2-AC05）。
  const xml = input.includes("\r") ? input.replace(/\r\n?/g, "\n") : input;
  // 旧の棚を写す: "top" は FXP の最上位の node、"outside" は Report の部分木の外の要素（木に作らない）、配列は Report の部分木の要素の子。
  // 閉じタグは名前を見ずに 1 段戻るので、過剰な閉じで棚が空になると current は undefined になる（旧の currentNode と同じ）。
  const parents: Array<XmlNode[] | "top" | "outside"> = [];
  let current: XmlNode[] | "top" | "outside" | undefined = "top";
  let root: XmlElement | null = null;
  // text はコメントをまたいで繋がり、タグで区切られる（旧の textData）。空の text は保存しない。
  let text = "";
  const saveText = (): void => {
    if (text === "") return;
    if (current === undefined) fallback();
    if (Array.isArray(current)) current.push({ kind: "text", value: xmlValue(text) });
    text = "";
  };
  // 旧の parseTree は最上位で最初の "Report" を root にする。ほかの最上位の要素とその中は木に作らない。
  const open = (name: string, attributes: string): XmlNode[] | "outside" => {
    if (current === undefined) fallback();
    const inside = Array.isArray(current) || (current === "top" && root == null && name === "Report");
    const list = attributeList(attributes, inside);
    if (!inside) return "outside";
    const children: XmlNode[] = [];
    const node: XmlElement = { kind: "element", name, attributes: list, children };
    if (Array.isArray(current)) current.push(node); else root = node;
    return children;
  };
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt < 0) break;
    if (lt > index) text += xml.slice(index, lt);
    const next = xml.charCodeAt(lt + 1);
    if (next === 47 /* / */) {
      const end = xml.indexOf(">", lt);
      if (end < 0) fallback();
      checkedName(xml.slice(lt + 2, end).trim());
      if (current !== undefined) saveText();
      text = "";
      current = parents.pop();
      index = end + 1;
    } else if (next === 63 /* ? */) {
      // D5: PI は最上位の XML 宣言だけを扱う（木に入らない）。ほかの PI は Report の中でも外でも旧の経路へ戻す（旧は "?name" の要素にし、
      // 引用符を見て ?> を探して、引用符の外のタブを空白にしてから擬似属性を読む。limits・validator とは区切りがずれうる）。
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0 || current !== "top" || !XML_DECLARATION.test(xml.slice(lt + 2, end))) fallback();
      text = "";
      index = end + 2;
    } else if (xml.startsWith("!--", lt + 1)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) fallback();
      index = end + 3;
    } else if (next === 33 /* ! */) {
      // D5: CDATA は実電文に無いので旧の経路へ戻す。D2: limits はコメントと CDATA 以外の <! を拒否するので、ここへ届くのは
      // 前処理と区切りがずれた入力だけ（旧の DocTypeReader は写さない）。
      fallback();
    } else {
      const end = quotedEnd(xml, lt + 1);
      if (end < 0) fallback();
      // validator が通した開きタグでは、FXP の切り方（名前は \s の前、末尾の / で空要素、引用符の外のタブは空白）と同じになる。
      const selfClosing = xml.charCodeAt(end - 1) === 47;
      const body = xml.slice(lt + 1, selfClosing ? end - 1 : end);
      const separator = body.search(WHITESPACE);
      const name = checkedName(separator < 0 ? body : body.slice(0, separator));
      if (current !== "top") saveText();
      text = "";
      if (selfClosing) open(name, separator < 0 ? "" : body.slice(separator + 1));
      else {
        // 旧の maxNestedTags（既定 100）。
        if (current === undefined || parents.length > 100) fallback();
        const children = open(name, separator < 0 ? "" : body.slice(separator + 1));
        parents.push(current);
        current = children;
      }
      index = end + 1;
    }
  }
  return root;
}

// 普通の入力は速い経路の木 1 本だけを作り、変な形はその入力だけ旧の経路で処理し直す（P3-WL2-AC01、P3-WL2-RES-01）。
function buildTree(xml: string): XmlElement | null {
  try { return fastTree(xml); } catch { return parseTree(xml); }
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

// parseTimes は測定の時だけ渡す記録（P3-C4-PARSE-MARK）。この thread の performance.now() で、開始は全文の最初の走査
// （withinXmlLimits）の直前、終了は parse tree の完成。渡さない呼出しの挙動と marks は変わらない。
/** Decodes, bounds, full-parses and resolves one mailbox item without retaining its raw body. */
export function decodeMaterial(item: ParserMailboxItem,
  parseTimes?: { startedMs: number | null; endedMs: number | null }): ParserMailboxResult {
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
    if (parseTimes != null) parseTimes.startedMs = now();
    withinXmlLimits(xmlText);
    if (XMLValidator.validate(xmlText) !== true) return rejected(item, "xmlInvalid", raw.byteLength);
  } catch (error) { return rejected(item, error instanceof Error && error.message === "xmlLimitExceeded" ? "xmlLimitExceeded" : "xmlInvalid", raw.byteLength); }
  const parsedAt = now();
  let xml: XmlElement | null;
  try { xml = buildTree(xmlText); } catch { return rejected(item, "xmlInvalid", raw.byteLength); }
  current.fullXmlParseMs = finiteDuration(parsedAt);
  if (parseTimes != null) parseTimes.endedMs = now();
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
