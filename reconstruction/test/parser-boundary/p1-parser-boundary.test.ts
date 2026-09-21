import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { deflateSync, gunzipSync, unzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { afterEach, expect, it, vi } from "vitest";
import type { Operation, OperationSourceEvidence } from "../../contracts/p1-parser-boundary.types";
import { ingestXmlData } from "../../src/ingress/ingress";
import { decodeMaterial, classifyMaterial, parserLimits } from "../../src/decode-material/decode-material";
import { resolveOperation } from "../../src/contracts-revision/operation";
import { classifyCorpus, envelope, measure } from "./evidence.mjs";

vi.mock("node:zlib", async (original) => {
  const z = await original<typeof import("node:zlib")>();
  return { ...z, gunzipSync: vi.fn(z.gunzipSync), unzipSync: vi.fn(z.unzipSync) };
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const api = { ingestXmlData, decodeMaterial, classifyMaterial };
const context = { inputId: "test", inputSequence: 1, receivedAt: 0, origin: "replay" as const };
const base = "<Report><Control><Status>通常</Status></Control><Head><EventID>001</EventID><Serial>02</Serial></Head><Body/></Report>";
function ingress(body: string | Uint8Array, kind: "replay" | "rest" = "replay") {
  return ingestXmlData({ ...context, kind, headType: "VPWS50", body: typeof body === "string" ? Buffer.from(body) : body });
}
function decode(body: string | Uint8Array) {
  const entered = ingress(body);
  return entered.kind === "accepted" ? decodeMaterial(entered.item) : entered;
}
function ws(frame: Uint8Array) { return ingestXmlData({ ...context, kind: "ws", frame }); }
function wsDecode(body: Uint8Array) {
  const entered = ws(envelope(body));
  return entered.kind === "accepted" ? decodeMaterial(entered.item) : entered;
}
function sizedXml(size: number) {
  // Insert padding inside Body, before the closing Report.
  const xml = base.replace("<Body/>", "<Body><!----></Body>");
  return xml.replace("<!---->", `<!--${"x".repeat(size - Buffer.byteLength(xml))}-->`);
}

it("P1-T01 corpusHistory / AC01: independently compares every XML and the explicit rejected fragment", () => {
  const rows = classifyCorpus(api);
  expect(rows).toHaveLength(239);
  expect(rows.filter(r => r.difference != null)).toEqual([]);
  expect(rows.filter(r => r.actual.kind === "decoded")).toHaveLength(238);
  const rejectedRows = classifyCorpus({ ...api, decodeMaterial: () => ({ kind: "rejected", diagnostic: { reason: "xmlInvalid" } }) });
  expect(rejectedRows.filter(r => r.difference != null)).toHaveLength(238);
});

it("P1-T02 acceptance / AC02-04: spies count decode, expansion and full parse, including pre-rejection", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  const frame = envelope(Buffer.from(base));
  const entered = ws(frame);
  expect(entered.kind).toBe("accepted");
  if (entered.kind !== "accepted") throw Error("ingress");
  const from = vi.spyOn(Buffer, "from");
  const result = decodeMaterial(entered.item);
  expect(result.kind).toBe("decoded");
  // Buffer.from のどのオーバーロードを spy が拾うかで引数タプル長が変わるので、呼び出し記録は位置で読む
  expect(from.mock.calls.filter((args: readonly unknown[]) => args[1] === "base64")).toHaveLength(1);
  expect(gunzipSync).toHaveBeenCalledTimes(1);
  expect(unzipSync).toHaveBeenCalledTimes(0);
  expect(parse).toHaveBeenCalledTimes(1);
  if (result.kind === "decoded") { classifyMaterial(result.material); classifyMaterial(result.material); }
  expect(parse).toHaveBeenCalledTimes(1);
  const zip = ws(envelope(Buffer.from(base), "VPWS50", { compression: "zip", body: deflateSync(Buffer.from(base)).toString("base64") }));
  if (zip.kind !== "accepted") throw Error("ingress");
  expect(decodeMaterial(zip.item).kind).toBe("decoded");
  expect(unzipSync).toHaveBeenCalledTimes(1);
  expect(gunzipSync).toHaveBeenCalledTimes(1);
  parse.mockClear();
  expect(ws(Buffer.alloc(parserLimits.inputBytes + 1))).toMatchObject({ kind: "rejected", diagnostic: { reason: "inputTooLarge" } });
  expect(parse).not.toHaveBeenCalled();
});

it("P1-T03 acceptance / AC05-08: corpus special values and lossless raw metadata", () => {
  const result = decode(readFileSync("test/fixtures/synthetic_phase4a_VXSE53_special.xml"));
  expect(result.kind).toBe("decoded");
  if (result.kind !== "decoded") throw Error("decode");
  const material = classifyMaterial(result.material);
  expect(material.materialValues).toEqual(expect.arrayContaining([
    { kind: "number", value: 4, raw: "４" }, { kind: "empty", raw: " 　" }, { kind: "range", bound: "lower", value: 5, raw: "" },
  ]));
  const extra = decode(base.replace("<Body/>", '<Body><n a="007">0</n><n>不明</n><n>3以下</n><n> keep </n></Body>'));
  if (extra.kind !== "decoded") throw Error("decode");
  expect(extra.material).toMatchObject({ eventIdRaw: "001", serialRaw: "02" });
  expect(classifyMaterial(extra.material).materialValues).toEqual(expect.arrayContaining([
    { kind: "number", value: 0, raw: "0" }, { kind: "unknown", raw: "不明" }, { kind: "range", bound: "upper", value: 3, raw: "3以下" }, { kind: "text", value: " keep ", raw: " keep " },
  ]));
  expect(JSON.stringify(extra.material.xml)).toContain('"name":"a","value":"007"');
  const absent = decode(base.replace("<EventID>001</EventID>", ""));
  if (absent.kind !== "decoded") throw Error("decode");
  expect(classifyMaterial(absent.material).metadata.eventId).toEqual({ kind: "missing" });
});

it("P1-T04 contractBoundary / AC09,R12: checks every source import and runtime export", async () => {
  function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
  const source = files("reconstruction/src").filter(p => p.endsWith(".ts")).map(p => readFileSync(p, "utf8")).join("\n");
  expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:\.\.\/\.\.\/\.\.\/src|engine|ui)[/"']/);
  expect([...source.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)].map(m => m[1] ?? m[2]).sort()).toEqual(["classifyMaterial", "decodeMaterial", "ingestXmlData", "parserLimits", "parserMailboxLimits", "recordParserDiagnostic", "resolveOperation"].sort());
});

it("P1-T05 contractBoundary / AC10: below/exact/over bytes and structure; no full parse on excess", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  for (const delta of [-1, 0, 1]) {
    const size = parserLimits.inputBytes + delta;
    const raw = Buffer.from(sizedXml(size));
    expect(raw.length).toBe(size);
    for (const kind of ["rest", "replay"] as const) {
      parse.mockClear();
      const entered = ingress(raw, kind);
      const result = entered.kind === "accepted" ? decodeMaterial(entered.item) : entered;
      expect(result.kind).toBe(delta > 0 ? "rejected" : "decoded");
      expect(parse).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
    }
    const tiny = envelope(Buffer.from(base));
    const frame = Buffer.concat([tiny, Buffer.alloc(size - tiny.length, 32)]);
    const json = vi.spyOn(JSON, "parse");
    const entered = ws(frame);
    expect(json).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
    json.mockRestore();
    expect(entered.kind).toBe(delta > 0 ? "rejected" : "accepted");
    if (entered.kind === "accepted") expect(decodeMaterial(entered.item).kind).toBe("decoded");
    parse.mockClear();
    const expanded = wsDecode(Buffer.from(sizedXml(parserLimits.expandedBytes + delta)));
    expect(expanded.kind).toBe(delta > 0 ? "rejected" : "decoded");
    if (delta > 0) expect(expanded).toMatchObject({ diagnostic: { reason: "expandedBodyTooLarge" } });
    expect(parse).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
  }
  const nodeBase = 8; // Report, Control, Status, Head, EventID, Serial, Body plus n container.
  const generators: Array<[number, (n: number) => string]> = [
    [320000, n => base.replace("<Body/>", `<Body><n>${"<x/>".repeat(n - nodeBase)}</n></Body>`)],
    [24, n => base.replace("<Body/>", `<Body>${"<n>".repeat(n - 2)}${"</n>".repeat(n - 2)}</Body>`)],
    [16, n => base.replace("<Body/>", `<Body ${Array.from({ length: n }, (_, i) => `a${i}=">"`).join(" ")}/>`)],
    [256, n => base.replace("<Body/>", `<Body a="${"x\n".repeat(Math.floor(n / 2))}${n % 2 ? "x" : ""}"/>`)],
    [16384, n => base.replace("<Body/>", `<Body>${"x".repeat(Math.floor(n / 2))}<!--split-->${"x".repeat(Math.ceil(n / 2))}</Body>`)],
  ];
  for (const [limit, generate] of generators) for (const delta of [-1, 0, 1]) {
    parse.mockClear();
    const result = decode(generate(limit + delta));
    expect(result.kind, `${limit}/${delta}`).toBe(delta > 0 ? "rejected" : "decoded");
    if (delta > 0) expect(result).toMatchObject({ diagnostic: { reason: "xmlLimitExceeded" } });
    expect(parse).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
  }
  const large = decodeMaterial({ ...context, headType: "VPWS50", encoding: "base64", compression: null, encodedBody: Buffer.alloc(8388608, 65), encodedByteLength: 8388608, headTest: { kind: "notProvided" }, envelopeStatus: { kind: "notProvided" } });
  expect(large.kind).toBe("rejected");
});

it("P1-T06 contractBoundary / AC11-13,15: all values/presences, B03 origins, and unobserved sources", () => {
  const absent = { kind: "notProvided" as const };
  const special = [absent, { kind: "missing" as const }, { kind: "invalid" as const, observed: "toString" }];
  const heads: OperationSourceEvidence<boolean>[] = [{ kind: "provided", value: false }, { kind: "provided", value: true }, ...special];
  const statuses: OperationSourceEvidence<Operation>[] = (["normal", "training", "test"] as const).map(value => ({ kind: "provided", value }));
  statuses.push(...special);
  for (const headTest of heads) for (const controlStatus of statuses) for (const envelopeStatus of statuses) {
    const e = { headTest, controlStatus, envelopeStatus };
    const all = Object.values(e);
    const real = [controlStatus, envelopeStatus].flatMap(s => s.kind === "provided" ? [s.value] : []);
    const reason = all.some(s => s.kind === "missing") ? "operationMissing" : all.some(s => s.kind === "invalid") ? "operationInvalid"
      : real.length === 0 ? "operationAmbiguous" : new Set(real).size > 1 || (headTest.kind === "provided" && headTest.value !== (real[0] !== "normal")) ? "operationMismatch" : null;
    const result = resolveOperation(e);
    expect(result).toMatchObject(reason == null ? { kind: "resolved", operation: real[0] } : { kind: "rejected", reason });
  }
  for (const origin of ["live", "recovery", "replay"] as const) {
    const entered = origin === "live" ? ingestXmlData({ ...context, origin, kind: "ws", frame: envelope(Buffer.from(base)) }) : ingestXmlData({ ...context, origin, kind: origin === "recovery" ? "rest" : "replay", body: Buffer.from(base), headType: "VPWS50" });
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(entered.item.headTest.kind).toBe(origin === "live" ? "provided" : "notProvided");
    expect(decodeMaterial(entered.item)).toMatchObject({ kind: "decoded", material: { origin, operation: "normal" } });
  }
  for (const value of ["toString", "__proto__", "constructor"]) {
    expect(decode(base.replace("通常", value))).toMatchObject({ kind: "rejected", diagnostic: { reason: "operationInvalid" } });
    const entered = ws(envelope(Buffer.from(base), "VPWS50", { xmlReport: { control: { status: value } } }));
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(decodeMaterial(entered.item)).toMatchObject({ diagnostic: { reason: "operationInvalid" } });
  }
  for (const format of ["json", "a/n", "binary", null]) expect(ws(envelope(Buffer.from(base), "VPWS50", { format }))).toMatchObject({ kind: "rejected", diagnostic: { reason: "formatUnsupported" } });
  for (const body of [base.replace("<Body/>", "<Body><x></y></Body>"), sizedXml(10485761)]) {
    const result = wsDecode(Buffer.from(body));
    if (result.kind !== "rejected") throw Error("unexpected acceptance");
    expect(result.diagnostic.operation).toEqual({ kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "provided", value: "normal" } } });
  }
  const broken = ws(envelope(Buffer.from(base), "VPWS50", { body: Buffer.from("broken gzip").toString("base64") }));
  if (broken.kind !== "accepted") throw Error("ingress");
  expect(decodeMaterial(broken.item)).toMatchObject({ kind: "rejected", diagnostic: { reason: "expandedBodyInvalid", operation: { kind: "undetermined" } } });
});

it("P1-T06 diagnostic boundary / RES08-10: stored evidence and escaped line/queue byte limits", () => {
  const scope = { exports: {}, require: () => ({ Buffer }), Buffer };
  const script = readFileSync("reconstruction/dist/src/diagnostics/parser-diagnostic.js", "utf8") + "\nexports.inspect = () => ({ diagnostics, diagnosticBytes });";
  runInNewContext(script, scope);
  const module = scope.exports as { recordParserDiagnostic: (d: unknown) => void; inspect: () => { diagnostics: string[]; diagnosticBytes: number } };
  for (let i = 0; i < 500; i++) module.recordParserDiagnostic({ inputId: "\u0000".repeat(9000), reason: "xmlInvalid", encodedByteLength: i, expandedByteLength: null, operation: { kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "invalid", observed: "toString" } } } });
  const saved = module.inspect();
  expect(saved.diagnostics.length).toBeLessThanOrEqual(256);
  expect(saved.diagnosticBytes).toBeLessThanOrEqual(1048576);
  for (const line of saved.diagnostics) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(line)).toMatchObject({ reason: "xmlInvalid", truncationReason: "fieldLimit", expandedByteLength: null, operation: { kind: "undetermined", sources: { headTest: { kind: "provided", value: false }, envelopeStatus: { kind: "invalid", observed: "toString" } } } });
    expect(JSON.parse(line).operation.sources).not.toHaveProperty("controlStatus");
  }
});

it("P1-T07 acceptance / AC14: actual input/result transfer and null stage reasons", async () => {
  for (const [file, type] of [["15_18_01_250630_VPWS50", "VPWS50"], ["81_09_01_260605_VPWP50", "VPWP50"], ["synthetic_phase4a_VXSE53_special", "VXSE53"]]) {
    const frame = envelope(readFileSync(`test/fixtures/${file}.xml`), type);
    const record = await measure({ ...context, inputId: file, kind: "ws", frame }, file, api);
    expect(Object.values(record.marks).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)).toBe(true);
    expect(record.unexecutedReasons).toEqual({});
    expect(record.transfer.inputBytes).toBeGreaterThan(500);
    expect(record.transfer.resultInputId).toBe(file);
    expect(record.transfer.resultNodes).toBe(record.nodes);
    if (type === "VPWS50") expect(record.nodes).toBe(155247);
  }
  const raw = await measure({ ...context, kind: "replay", headType: "VPWS50", body: Buffer.from(base) }, "raw", api);
  for (const key of ["ingressJsonMs", "base64DecodeMs", "decompressionMs"]) { expect(raw.marks[key]).toBeNull(); expect(raw.unexecutedReasons[key]).toBeTruthy(); }
});

it("A / AC05-07,10: references have identical semantic values and expanded character limits", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  for (const reference of ["&#65;", "&#x41;", "&#x1F600;", "&amp;", "&lt;", "&gt;", "&apos;", "&quot;"]) {
    const character = reference === "&#65;" || reference === "&#x41;" ? "A" : reference === "&#x1F600;" ? "😀" : ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&quot;": '"' })[reference]!;
    for (const attribute of [false, true]) for (const delta of [0, 1]) {
      const limit = attribute ? 256 : 16384;
      const value = reference.repeat(limit + delta);
      parse.mockClear();
      const result = decode(base.replace("<Body/>", attribute ? `<Body a="${value}"/>` : `<Body>${value}</Body>`));
      expect(result.kind).toBe(delta === 0 ? "decoded" : "rejected");
      expect(parse).toHaveBeenCalledTimes(delta === 0 ? 1 : 0);
      if (result.kind === "decoded") {
        const body = result.material.xml.children.find(n => n.kind === "element" && n.name === "Body");
        if (body?.kind !== "element") throw Error("Body");
        expect(attribute ? body.attributes[0].value : body.children.map(n => n.kind === "text" ? n.value : "").join("")).toBe(character.repeat(limit));
      } else expect(result.diagnostic.reason).toBe("xmlLimitExceeded");
    }
  }
  const semantic = decode(base.replace("通常", "&#36890;&#x5E38;").replace("<Body/>", "<Body><n>&#52;</n><n>&amp;#65;</n><n><![CDATA[&#65;&bogus;]]></n></Body>"));
  if (semantic.kind !== "decoded") throw Error("references");
  expect(semantic.material.operation).toBe("normal");
  expect(classifyMaterial(semantic.material).materialValues).toEqual(expect.arrayContaining([{ kind: "number", value: 4, raw: "4" }, { kind: "text", value: "&#65;", raw: "&#65;" }, { kind: "text", value: "&#65;&bogus;", raw: "&#65;&bogus;" }]));
});

it("B / AC15: undeclared entities and non-XML character references reject before full parse", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  for (const value of ["&bogus;", "&#0;", "&#xD800;", "&#xDFFF;", "&#x110000;", "&#xFFFF;", "&#x1;", "&AMP;", "&#x;", "&amp", "\u0000"]) {
    for (const body of [`<Body>${value}</Body>`, `<Body a="${value}"/>`]) {
      const result = decode(base.replace("<Body/>", body));
      expect(result).toMatchObject({ kind: "rejected", diagnostic: { reason: "xmlInvalid", operation: { kind: "undetermined" } } });
    }
  }
  expect(parse).not.toHaveBeenCalled();
});

it("C / AC10,12: explicit transport metadata, unchanged body bytes and rejected fake headers", () => {
  for (const [field, reason, invalid] of [["encoding", "encodingUnsupported", ["binary", "toString", null]], ["compression", "compressionUnsupported", ["brotli", "__proto__", false]]] as const) {
    for (const value of invalid) expect(ws(envelope(Buffer.from(base), "VPWS50", { [field]: value }))).toMatchObject({ kind: "rejected", diagnostic: { reason } });
  }
  for (const prefix of ["UN\n", "UX\n"]) expect(decode(prefix + base)).toMatchObject({ kind: "rejected", diagnostic: { reason: "xmlInvalid" } });
  for (const kind of ["rest", "replay"] as const) {
    const entered = ingress(base, kind);
    if (entered.kind !== "accepted") throw Error("ingress");
    expect(entered.item).toMatchObject({ encoding: "utf-8", compression: null, encodedByteLength: Buffer.byteLength(base) });
    expect(entered.item.encodedBody).toEqual(Buffer.from(base));
  }
  const entered = ws(envelope(Buffer.from(base), "VPWS50", { encoding: "utf-8", compression: null, body: base }));
  if (entered.kind !== "accepted") throw Error("ingress");
  expect(entered.item).toMatchObject({ encoding: "utf-8", compression: null, encodedByteLength: Buffer.byteLength(base) });
  expect(entered.item.encodedBody).toEqual(Buffer.from(base));
  expect(decodeMaterial(entered.item).kind).toBe("decoded");
});

it("D / AC06: UTF-8 BOM is accepted and does not enter the XML tree", () => {
  const plain = decode(base);
  if (plain.kind !== "decoded") throw Error("decode");
  for (const kind of ["rest", "replay"] as const) {
    const entered = ingress(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(base)]), kind);
    if (entered.kind !== "accepted") throw Error("ingress");
    const result = decodeMaterial(entered.item);
    if (result.kind !== "decoded") throw Error("BOM");
    expect(result.material.xml).toEqual(plain.material.xml);
    expect(result.material.expandedByteLength).toBe(Buffer.byteLength(base) + 3);
  }
});
